import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BIP39_ENGLISH } from "../src/link/bip39-english.ts";
import { keyRecordHash, newDeviceKeys, recordOf, type DeviceKeys } from "../src/link/device.ts";
import { buildEnvelope, openEnvelope, recordTaken, type Envelope, type Opened, type ReceiveState } from "../src/link/envelope.ts";
import { ConflictError, NotFoundError, UnauthorizedError, UnprocessableError } from "../src/link/errors.ts";
import { buildJoinRequest, checkJoiner, decodeInvite, encodeInvite, inviteHash, openJoinRequest, safetyWords, type Invite } from "../src/link/join.ts";
import { encodePlaintext, type TowerMessage } from "../src/link/kinds.ts";
import { Outbox } from "../src/link/outbox.ts";
import { ManagedStream, RelayClient } from "../src/link/relay.ts";
import { addEntry, createEntry, removeEntry, replayRoster, type RosterEntry, type RosterState } from "../src/link/roster.ts";
import type { Disposition, RelayEvent } from "../src/link/sse.ts";
import { until } from "./link/fakes.ts";

// Two clients against the real relay (docs/specs/2026-10-25-straw-link.md, Build order 2). The test builds the relay from a clean `git archive HEAD`
// snapshot of STRAW_RELAY_DIR (default ~/projects/straw-relay), runs it on a free port with an operator token, drives devices A and B through
// create, invite, join, send, receive, ack, reconnect, presence, and removal, then kills the one process it started and removes its temp dir.
// It is skipped, with the reason, where `go` or the relay checkout is missing.

const RELAY_DIR = process.env.STRAW_RELAY_DIR ?? join(homedir(), "projects", "straw-relay");
const goMissing = spawnSync("go", ["version"], { encoding: "utf8" }).status !== 0;
const skip = goMissing ? "skipped: `go` is not installed" : !existsSync(join(RELAY_DIR, ".git")) ? `skipped: no straw-relay checkout at ${RELAY_DIR} (set STRAW_RELAY_DIR)` : false;
if (skip) console.log(`# link-relay-live ${skip}`);

const git = (...args: string[]) => spawnSync("git", ["-C", RELAY_DIR, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
const freePort = () =>
	new Promise<number>((resolve, reject) => {
		const s = createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address() as { port: number };
			s.close(() => resolve(port));
		});
	});

/** A device in the test: its keys, its client, what it has received, and the receive checks' state. */
class Peer {
	readonly keys: DeviceKeys;
	client!: RelayClient;
	roster!: RosterState;
	stream: ManagedStream | undefined;
	readonly events: RelayEvent[] = [];
	readonly delivered: Extract<Opened, { ok: true }>[] = [];
	readonly held: Extract<Opened, { ok: true }>[] = [];
	readonly dropped: { reason: string; seq: number }[] = [];
	/** Envelopes with this text are received but not delivered (the holder "crashed" before writing them): the handler answers keep. */
	holdText: string | undefined;
	private lastSeq = new Map<string, number>();
	private lastEphemeral = new Map<string, number>();
	private team: Buffer;

	constructor(team: Buffer) {
		this.keys = newDeviceKeys();
		this.team = team;
	}

	receiveState(): ReceiveState {
		return { team: this.team, self: this.keys.id, roster: this.roster, keys: this.roster.keys, lastSeq: this.lastSeq, lastEphemeral: this.lastEphemeral, now: Date.now() };
	}

	handle = (e: RelayEvent): Disposition | void => {
		this.events.push(e);
		if (e.type !== "envelope") return;
		const opened = openEnvelope(e.envelope, this.receiveState());
		if (!opened.ok) {
			this.dropped.push({ reason: opened.reason, seq: e.envelope.header.seq });
			return "ack";
		}
		if (opened.header.kind === "tower" && (opened.message as TowerMessage).text === this.holdText) {
			this.held.push(opened);
			return "keep";
		}
		const next = recordTaken(this.receiveState(), opened.header);
		this.lastSeq = next.lastSeq;
		this.lastEphemeral = next.lastEphemeral;
		this.delivered.push(opened);
		return "ack";
	};

	listen(team: Buffer, lastEventId?: number): ManagedStream {
		this.stream = this.client.stream(team, { onEvent: this.handle, lastEventId, backoff: () => 20 });
		this.stream.start();
		return this.stream;
	}

	rosterEvents() {
		return this.events.flatMap((e) => (e.type === "roster" ? [e] : []));
	}
	towers(): { text: string; seq: number }[] {
		return this.delivered.filter((d) => d.header.kind === "tower").map((d) => ({ text: (d.message as TowerMessage).text, seq: d.header.seq }));
	}
}

describe("two clients against the real relay", { skip }, () => {
	const work = mkdtempSync(join(tmpdir(), "straw-link-live-"));
	const team = randomBytes(16), key1 = randomBytes(32), key2 = randomBytes(32);
	let relay: ChildProcess | undefined, relayLog = "", url = "", token = "";
	let a!: Peer, b!: Peer, outbox: Outbox, invite!: Invite, inviteText = "", secret!: Buffer;
	let aSeq = 0;
	let cursorPastTower = 0, bWords: string[] = [];

	const post = (peer: Peer) => (bytes: Buffer, signal: AbortSignal) => peer.client.postEnvelope(team, bytes, signal);
	const build = (from: Peer, kind: "tower" | "presence", seq: number, text: string, to: string[] = []): Envelope =>
		buildEnvelope({
			team, epoch: from.roster.epoch, teamKey: from.roster.keys.get(from.roster.epoch)!, head: from.roster.head, from: from.keys, seq, ts: Date.now(), kind,
			to: kind === "presence" ? [] : to,
			plaintext: kind === "tower" ? encodePlaintext("tower", { fromWorkspace: "work", toWorkspace: "", replyExpected: false, text }) : encodePlaintext("presence", { label: text, headSeq: from.roster.head.seq, headHash: from.roster.head.hash, workspaces: [] }),
		});
	const replay = (peer: Peer, entries: RosterEntry[]) => {
		const r = replayRoster(team, entries, { self: peer.keys, keys: peer === a ? new Map([[1, key1]]) : undefined });
		assert.ok(r.ok, r.ok ? "" : `roster replay failed: ${r.reason} at ${r.seq}`);
		return r.value;
	};

	before(async (t) => {
		const head = git("rev-parse", "HEAD").stdout.trim(), dirty = git("status", "--porcelain").stdout.trim();
		console.log(`# link-relay-live: relay HEAD ${head}${dirty ? " (the checkout has uncommitted changes; the snapshot is HEAD only)" : ""}`);
		t.diagnostic(`relay HEAD ${head}`);
		const src = join(work, "src"), bin = join(work, "straw-relay"), db = join(work, "relay.db");
		mkdirSync(src);
		const archive = spawnSync("git", ["-C", RELAY_DIR, "archive", "HEAD"], { maxBuffer: 1 << 28 });
		assert.equal(archive.status, 0, `git archive failed: ${archive.stderr}`);
		const tar = spawnSync("tar", ["-x", "-C", src], { input: archive.stdout });
		assert.equal(tar.status, 0, `tar failed: ${tar.stderr}`);
		const built = spawnSync("go", ["build", "-o", bin, "./cmd/straw-relay"], { cwd: src, encoding: "utf8", timeout: 900_000 });
		assert.equal(built.status, 0, `go build failed:\n${built.stderr}`);
		const made = spawnSync(bin, ["token", "create", "--db", db], { encoding: "utf8" });
		assert.equal(made.status, 0, `token create failed: ${made.stderr}`);
		token = made.stdout.trim();
		assert.match(token, /^srt1_/);
		const port = await freePort();
		url = `http://127.0.0.1:${port}`;
		relay = spawn(bin, ["serve", "--addr", `127.0.0.1:${port}`, "--db", db], { stdio: ["ignore", "pipe", "pipe"] });
		// A failed assertion that ends the runner without `after` must not leave the relay running.
		process.once("exit", () => relay?.kill("SIGKILL"));
		console.log(`# link-relay-live: relay pid ${relay.pid} on ${url}`);
		relay.stdout!.on("data", (d: Buffer) => void (relayLog += d.toString()));
		relay.stderr!.on("data", (d: Buffer) => void (relayLog += d.toString()));
		a = new Peer(team);
		b = new Peer(team);
		a.client = new RelayClient({ url, device: a.keys });
		b.client = new RelayClient({ url, device: b.keys });
		const stop = Date.now() + 15_000;
		for (;;) {
			try {
				if (await a.client.health()) break;
			} catch {
				if (Date.now() > stop) throw new Error(`the relay did not come up:\n${relayLog}`);
				await new Promise((r) => setTimeout(r, 50));
			}
		}
	});

	after(async () => {
		await Promise.allSettled([a?.stream?.stop(), b?.stream?.stop(), outbox?.stop()]);
		const pid = relay?.pid;
		if (relay && pid !== undefined && relay.exitCode === null) {
			const exited = new Promise<void>((resolve) => relay!.once("exit", () => resolve()));
			relay.kill("SIGTERM");
			const killer = setTimeout(() => relay!.kill("SIGKILL"), 5000);
			await exited;
			clearTimeout(killer);
			console.log(`# link-relay-live: relay pid ${pid} stopped`);
		}
		if (basename(work).startsWith("straw-link-live-") && work.startsWith(tmpdir())) rmSync(work, { recursive: true, force: true });
	});

	it("A creates the team with the operator token; a wrong token is refused", async () => {
		const entry = createEntry({ team, founder: a.keys, label: "alice-mac", teamKey: key1 });
		const wrong = await a.client.createTeam({ team: randomBytes(16), token: "srt1_wrong", entry: createEntry({ team: Buffer.alloc(16, 1), founder: a.keys, label: "x", teamKey: key1 }) }).catch((e) => e);
		assert.ok(wrong instanceof Error && (wrong as UnauthorizedError | UnprocessableError).status >= 400, "a refused create is a typed error");
		const head = await a.client.createTeam({ team, token, entry });
		assert.equal(head.seq, 0);
		a.roster = replay(a, [entry]);
		const roster = await a.client.getRoster(team);
		assert.equal(roster.entries.length, 1);
		assert.ok(roster.head.hash.equals(head.hash));
		const unknown = await b.client.getRoster(team).catch((e) => e);
		assert.ok(unknown instanceof UnauthorizedError && unknown.code === "not-member", "B is no member yet");
	});

	it("A invites; B joins with the QR text; A checks the request and the safety words", async () => {
		a.listen(team);
		secret = randomBytes(32);
		invite = { relay: url, team, secret, inviterId: a.keys.id, inviterKeyHash: keyRecordHash(a.keys), forDevice: "" };
		inviteText = encodeInvite(invite);
		const expires = Date.now() + 10 * 60_000;
		assert.equal(await a.client.createInvite({ team, hash: inviteHash(secret), expires }), expires);

		const scanned = decodeInvite(inviteText);
		assert.ok(scanned);
		const blob = buildJoinRequest({ team: scanned.team, secret: scanned.secret, record: recordOf(b.keys), label: "bob-mac" });
		// B shows its words before any add: from the QR's inviter key hash alone (the roster answers 401 until B is a member).
		bWords = safetyWords({ team: scanned.team, inviterKeyHash: scanned.inviterKeyHash, joiner: recordOf(b.keys), secret: scanned.secret });
		await b.client.join(inviteHash(scanned.secret), blob);
		const again = await b.client.join(inviteHash(scanned.secret), blob).catch((e) => e);
		assert.ok(again instanceof ConflictError && again.code === "invite-used", "an invite works once");
		const nobody = await b.client.join(Buffer.alloc(32, 9), blob).catch((e) => e);
		assert.ok(nobody instanceof NotFoundError, "an unknown invite is 404");

		const join = await until(() => a.events.find((e) => e.type === "join"), 10_000, "the join request on A's stream");
		assert.ok(join.type === "join" && join.hash.equals(inviteHash(secret)));
		const opened = openJoinRequest({ team, secret, blob: join.request, forDevice: "", roster: a.roster });
		assert.ok(opened.ok, opened.ok ? "" : opened.reason);
		assert.equal(opened.label, "bob-mac");
		assert.equal(opened.record.id, b.keys.id);
		const words = safetyWords({ team, inviterKeyHash: keyRecordHash(a.keys), joiner: opened.record, secret });
		assert.equal(words.length, 4);
		for (const w of words) assert.ok(BIP39_ENGLISH.includes(w));
		assert.deepEqual(words, bWords, "A's words match what B showed from the QR, before posting the add");
	});

	it("A posts the add (a stale one is a 409 with the head); B checks the roster and opens the team key", async () => {
		const add = addEntry({ state: a.roster, signer: a.keys, record: recordOf(b.keys), label: "bob-mac", attended: true });
		const head = await a.client.appendRoster(team, add);
		assert.equal(head.seq, 1);
		const stale = await a.client.appendRoster(team, add).catch((e) => e);
		assert.ok(stale instanceof ConflictError && stale.head?.seq === 1, "the same entry again no longer extends the head");
		a.roster = replay(a, [...a.roster.entries, add]);

		const rows = await b.client.waitForMembership(team, { intervalMs: 20 });
		assert.equal(rows.entries.length, 2);
		const checked = checkJoiner({ invite, self: b.keys, entries: rows.entries.map((r) => r.entry), label: "bob-mac" });
		assert.ok(checked.ok, checked.ok ? "" : checked.reason);
		b.roster = checked.state;
		assert.ok(b.roster.keys.get(1)?.equals(key1), "B opened the team key sealed to it");
	});

	it("A sends a tower message to B; B receives it over SSE, opens it, and acknowledges it after delivering", async () => {
		b.listen(team);
		outbox = new Outbox({ post: post(a), reserveSeq: () => ++aSeq, backoff: () => 20 });
		await outbox.submit((seq) => build(a, "tower", seq, "hello from A", [b.keys.id]));
		await outbox.idle();
		await until(() => b.towers().length === 1, 10_000, "B delivering the message");
		assert.deepEqual(b.towers(), [{ text: "hello from A", seq: 1 }]);
		assert.equal(b.delivered[0]!.header.from, a.keys.id);
		await b.stream!.acks.flush();
	});

	it("an unacknowledged envelope comes again on a fresh stream; an acknowledged one does not", async () => {
		b.holdText = "write me down";
		await outbox.submit((seq) => build(a, "tower", seq, "write me down", [b.keys.id]));
		await outbox.idle();
		const held = await until(() => b.held[0], 10_000, "B receiving the held envelope");
		assert.equal(held.header.seq, 2);
		const envelopeEvents = b.events.filter((e) => e.type === "envelope");
		cursorPastTower = envelopeEvents.at(-1)!.eid;

		// A probe that starts from the beginning sees the unacked envelope, not the acked one.
		const probe = new Peer(team);
		Object.assign(probe, { roster: b.roster });
		probe.client = new RelayClient({ url, device: b.keys });
		const stream = probe.client.stream(team, { onEvent: (e) => void probe.events.push(e), backoff: () => 20 });
		stream.start();
		await until(() => probe.events.some((e) => e.type === "envelope"), 10_000, "the probe's replay");
		await new Promise((r) => setTimeout(r, 100));
		await stream.stop();
		const seqs = probe.events.flatMap((e) => (e.type === "envelope" ? [e.envelope.header.seq] : []));
		assert.deepEqual(seqs, [2], "seq 1 was acknowledged and is gone; seq 2 was not");
	});

	it("reconnecting B with a Last-Event-ID past the unacknowledged envelope still delivers it", async () => {
		await b.stream!.stop();
		assert.ok(cursorPastTower > 0);
		b.holdText = undefined;
		b.listen(team, cursorPastTower);
		await until(() => b.towers().some((t) => t.seq === 2), 10_000, "the envelope again, past the cursor (needs the relay to resend unacknowledged envelopes whatever Last-Event-ID says)");
		assert.deepEqual(b.towers().map((t) => t.text), ["hello from A", "write me down"]);
		await b.stream!.acks.flush();
	});

	it("presence from both sides arrives as an ephemeral envelope and is never acknowledged", async () => {
		const sent = await a.client.postEnvelope(team, build(a, "presence", 0, "alice-mac"));
		assert.equal(sent.duplicate, false);
		await until(() => b.delivered.some((d) => d.header.kind === "presence"), 10_000, "A's presence at B");
		const fromA = b.delivered.find((d) => d.header.kind === "presence")!;
		assert.equal(fromA.header.from, a.keys.id);
		assert.equal(fromA.header.seq, 0);
		assert.ok(fromA.header.ephemeral);
		await b.client.postEnvelope(team, build(b, "presence", 0, "bob-mac"));
		await until(() => a.delivered.some((d) => d.header.kind === "presence"), 10_000, "B's presence at A");
		assert.equal((a.delivered.find((d) => d.header.kind === "presence")!.message as { label: string }).label, "bob-mac");
	});

	it("A removes B: B's stream shows it its removal and ends, and B's next request is 401", async () => {
		const removal = removeEntry({ state: a.roster, signer: a.keys, subjectId: b.keys.id, newKey: key2 });
		const head = await a.client.appendRoster(team, removal);
		assert.equal(head.seq, 2);
		a.roster = replay(a, [...a.roster.entries, removal]);
		assert.equal(a.roster.epoch, 2);

		const end = await b.stream!.done;
		assert.equal(end.reason, "refused");
		assert.ok(end.reason === "refused" && end.error instanceof UnauthorizedError && end.error.status === 401);
		const sawRemoval = b.rosterEvents().find((e) => e.entry.op === "remove");
		assert.ok(sawRemoval && sawRemoval.entry.subject?.record.id === b.keys.id, "B was shown the entry that removed it");
		const seen = replay(b, b.rosterEvents().map((e) => e.entry));
		assert.ok(seen.selfRemoved);

		const attempts = [() => b.client.getRoster(team), () => b.client.postEnvelope(team, build(b, "tower", 1, "let me back in", [a.keys.id])), () => b.client.ack(team, [randomBytes(16)])];
		for (const attempt of attempts) {
			const error = await attempt().catch((e) => e);
			assert.ok(error instanceof UnauthorizedError && error.status === 401, `a removed device is 401, got ${error?.constructor?.name}`);
		}
	});

	it("A's later envelope to the removed B is refused by the relay with a typed 422, and the outbox moves on", async () => {
		const refused: unknown[] = [];
		const o2 = new Outbox({ post: post(a), reserveSeq: () => ++aSeq, backoff: () => 20, onRejected: (_i, e) => void refused.push(e) });
		await o2.submit((seq) => build(a, "tower", seq, "anyone there?", [b.keys.id]));
		await o2.idle();
		await o2.stop();
		assert.equal(refused.length, 1);
		assert.ok(refused[0] instanceof UnprocessableError && refused[0].status === 422);
		assert.equal((refused[0] as UnprocessableError).code, "no-addressee");
	});
});
