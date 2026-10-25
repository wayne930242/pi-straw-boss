import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, describe, it } from "node:test";
import { RelayClient } from "../src/link/relay.ts";
import type { RelayEvent } from "../src/link/sse.ts";
import { LinkStore } from "../src/link/store.ts";
import { alice, bob, rosterOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { relaySkip, startRelay, type LiveRelay } from "./link/live-relay.ts";
import { TEAM, teamKey } from "./link/scenario.ts";

// Two pi-like link-holder processes per computer against the real relay (docs/specs/2026-10-25-straw-link.md, Build order 3): a `tower` message from
// device A reaches device B's tower channel or inbox; a holder that crashes before the inbox write, or after it and before the acknowledgement,
// gets the message again exactly once; and when the holder process is killed the other candidate of that computer takes over. The processes are
// tests/link/holder-child.ts: the election and the holder of src/link/ with a stand-in for the tower. Skipped where `go` or the relay checkout is missing.

if (relaySkip) console.log(`# link-holder-live ${relaySkip}`);

interface Child { proc: ChildProcess; name: string; lines: Record<string, unknown>[]; exited: Promise<number | null>; say(line: string): void }

/** `until` for a check that is async: polls until it answers truthy. */
async function until<T>(check: () => T | Promise<T>, ms: number, what: string): Promise<void> {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (await check()) return;
	throw new Error(`timed out waiting for ${what}`);
}

describe("link holders against the real relay", { skip: relaySkip }, () => {
	const work = mkdtempSync(join(tmpdir(), "psb-holder-live-測試-"));
	const dirA = join(work, "a", "link"), dirB = join(work, "b", "link"), projA = join(work, "proj-a"), projB = join(work, "proj-b");
	let relay!: LiveRelay;
	const children: Child[] = [];

	const launch = (name: string, dir: string, project: string, o: { tower?: boolean; mode?: string } = {}): Child => {
		const proc = spawn(process.execPath, [new URL("./link/holder-child.ts", import.meta.url).pathname, dir, relay.url, project, name, ...(o.tower === false ? [] : ["tower"])], { env: { ...process.env, MODE: o.mode ?? "none" }, stdio: ["pipe", "pipe", "inherit"] });
		const lines: Record<string, unknown>[] = [];
		createInterface({ input: proc.stdout! }).on("line", (l) => void lines.push(JSON.parse(l) as Record<string, unknown>));
		const child: Child = { proc, name, lines, exited: new Promise((resolve) => proc.once("exit", (code, signal) => resolve(code ?? (signal ? -1 : null)))), say: (l) => void proc.stdin!.write(`${l}\n`) };
		children.push(child);
		return child;
	};
	const seen = (c: Child, ev: string) => c.lines.find((l) => l.ev === ev);
	const kill = async (c: Child) => {
		if (c.proc.exitCode === null && c.proc.signalCode === null) c.proc.kill("SIGKILL");
		await c.exited;
	};
	const teamB = () => new LinkStore(dirB);
	const inbox = () => teamB().inboxIds().map((id) => teamB().readInbox(id)!.text);
	/** What B's relay queue still holds: a fresh stream as B, listened to for a moment. */
	const pendingAtRelay = async (): Promise<number> => {
		const events: RelayEvent[] = [];
		let open = false;
		const client = new RelayClient({ url: relay.url, device: bob });
		const stream = client.stream(TEAM, { onEvent: (e) => void events.push(e), backoff: () => 50, onState: (st) => void (open ||= st.state === "open") });
		void stream.start();
		// A busy machine connects slowly: the count is read a moment after the stream opened, never after a fixed wait alone.
		await until(() => open, 15_000, "the probe stream to open");
		await new Promise((r) => setTimeout(r, 500));
		await stream.stop();
		return events.filter((e) => e.type === "envelope" && !e.ephemeral).length;
	};

	before(async () => {
		relay = await startRelay();
		for (const dir of [projA, projB]) mkdirSync(dir, { recursive: true });
		const entries = rosterOf();
		const a = new RelayClient({ url: relay.url, device: alice });
		await a.createTeam({ team: TEAM, token: relay.token, entry: entries[0]! });
		await a.appendRoster(TEAM, entries[1]!);
		for (const [dir, keys, label] of [[dirA, alice, "alice-mac"], [dirB, bob, "bob-mac"]] as const) {
			const store = new LinkStore(dir);
			writeDevice(store, keys, label);
			writeTeam(store, entries, keys, { relay: relay.url });
		}
	});
	after(async () => {
		for (const c of children) if (c.proc.exitCode === null && c.proc.signalCode === null) c.proc.kill("SIGKILL");
		await Promise.allSettled(children.map((c) => c.exited));
		await relay?.stop();
		if (work.startsWith(tmpdir())) rmSync(work, { recursive: true, force: true });
	});

	it("a tower message from A reaches B's tower channel; the same message to a computer with no tower waits in B's inbox", async () => {
		const a = launch("a1", dirA, projA), b = launch("b1", dirB, projB);
		await until(() => seen(a, "gain") && seen(b, "gain"), 15_000, "both holders");
		a.say("send bob-mac hello from A");
		await until(() => seen(a, "sent"), 15_000, "A's send");
		assert.equal(seen(a, "sent")!.ok, true, JSON.stringify(seen(a, "sent")));
		await until(() => seen(b, "offer"), 15_000, "B's tower to be offered the message");
		assert.deepEqual([seen(b, "offer")!.text, seen(b, "offer")!.from, seen(b, "offer")!.tower], ["hello from A", "alice-mac", "tower-b1"]);
		await until(() => inbox().length === 0, 5000, "the tower took it out of the inbox");
		await until(async () => (await pendingAtRelay()) === 0, 15_000, "the relay to hold nothing for B");
		await kill(b);

		const b2 = launch("b2", dirB, projB, { tower: false });
		await until(() => seen(b2, "gain"), 15_000, "B's holder without a tower");
		a.say("send bob-mac waits for a tower");
		await until(() => inbox().includes("waits for a tower"), 15_000, "the message in B's inbox");
		assert.equal(b2.lines.filter((l) => l.ev === "offer").length, 0, "no tower, no offer");
		await until(async () => (await pendingAtRelay()) === 0, 15_000, "acknowledged once it was in the inbox");
		await kill(b2);
		assert.deepEqual(inbox(), ["waits for a tower"]);
	});

	it("a holder killed before it writes the inbox gets the message again; it is delivered once, and the dead holder's lock is taken over", async () => {
		const a = children.find((c) => c.name === "a1")!;
		const doomed = launch("b3", dirB, projB, { tower: false, mode: "crash-before-put" });
		await until(() => seen(doomed, "gain"), 15_000, "the doomed holder");
		a.say("send bob-mac crash before put");
		await doomed.exited;
		assert.ok(seen(doomed, "crashing"));
		assert.ok(!inbox().includes("crash before put"), "it never reached the inbox");
		assert.equal(await pendingAtRelay(), 1, "the relay still holds it: nothing was acknowledged");

		const b4 = launch("b4", dirB, projB, { tower: false });
		await until(() => inbox().includes("crash before put"), 20_000, "the message after the restart");
		await until(async () => (await pendingAtRelay()) === 0, 15_000, "acknowledged now");
		assert.equal(inbox().filter((t) => t === "crash before put").length, 1);
		await kill(b4);
	});

	it("a holder killed after the inbox write and before the acknowledgement: the relay sends it again, the sequence guard drops the copy, one message remains", async () => {
		const a = children.find((c) => c.name === "a1")!;
		const before = inbox().length;
		const held = launch("b5", dirB, projB, { tower: false, mode: "hold-ack" });
		await until(() => seen(held, "gain"), 15_000, "the holder that never acknowledges");
		a.say("send bob-mac stored but not acked");
		await until(() => seen(held, "ack-held"), 15_000, "the ack it holds back");
		assert.ok(inbox().includes("stored but not acked"));
		await kill(held);
		assert.equal(await pendingAtRelay(), 1, "the relay still holds it");

		const b6 = launch("b6", dirB, projB, { tower: false });
		await until(async () => (await pendingAtRelay()) === 0, 20_000, "the redelivered copy acknowledged");
		assert.equal(inbox().length, before + 1);
		assert.equal(inbox().filter((t) => t === "stored but not acked").length, 1, "one copy");
		const log = readFileSync(join(dirB, "link.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { event: string; reason?: string; kind?: string });
		assert.ok(log.some((l) => l.event === "drop" && l.reason === "stale-seq" && l.kind === "tower"), `the second copy was dropped by the guard: ${JSON.stringify(log.filter((l) => l.event !== "notice"))}`);
		await kill(b6);
	});

	it("two candidates on one computer: when the holder process is killed the other takes over within seconds and receives what A sends next", async () => {
		const a = children.find((c) => c.name === "a1")!;
		const first = launch("b7", dirB, projB), second = launch("b8", dirB, projB);
		await until(() => seen(first, "gain") || seen(second, "gain"), 15_000, "a holder");
		const [holder, other] = seen(first, "gain") ? [first, second] : [second, first];
		await new Promise((r) => setTimeout(r, 500));
		assert.equal(seen(other, "gain"), undefined, "one holder at a time");
		assert.equal(new LinkStore(dirB).readHolder()!.session, holder.name);
		await kill(holder);
		await until(() => seen(other, "gain"), 15_000, "the other candidate to take over");
		assert.equal(new LinkStore(dirB).readHolder()!.session, other.name);
		a.say("send bob-mac after the takeover");
		await until(() => other.lines.some((l) => l.ev === "offer" && l.text === "after the takeover"), 20_000, "the new holder offering the message");
		await until(async () => (await pendingAtRelay()) === 0, 15_000, "acknowledged by the new holder");
		await kill(other);
		a.say("quit");
		void teamKey;
	});
});
