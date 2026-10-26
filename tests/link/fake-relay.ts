import { Buffer } from "node:buffer";
import { decodeEntry, entryHash, type RosterEntry, encodeEntry } from "../../src/link/roster.ts";
import { encodeEnvelope, parseEnvelope, type Envelope } from "../../src/link/envelope.ts";

// An in-memory relay behind a `fetch`: the endpoints the link holder uses (envelopes, events, acks, roster), with the delivery rules that matter to
// it. Queued envelopes are kept until the addressee acknowledges them and come again on every new stream, whatever its Last-Event-ID; ephemeral
// ones reach only open streams. It does not check signatures: the real relay does, in tests/link-relay-live.test.ts.

interface Stored { id: string; envelope: Envelope; to: Set<string>; ephemeral: boolean; acked: Set<string> }
interface Stream { device: string; team: string; controller: ReadableStreamDefaultController<Uint8Array>; closed: boolean }

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class FakeRelay {
	/** Members by team (hex): who an envelope with an empty `to` goes to. */
	members = new Map<string, string[]>();
	rosters = new Map<string, RosterEntry[]>();
	stored: Stored[] = [];
	streams: Stream[] = [];
	/** Each stream opened: the device and the Last-Event-ID it sent. */
	opened: { device: string; lastEventId: string | null }[] = [];
	/** Every ack request: the device, the ids, and what `onAck` saw. */
	acks: { device: string; ids: string[] }[] = [];
	onAck: ((device: string, ids: string[]) => void) | undefined;
	/** Acks are swallowed (answered 200 but not applied): a holder that crashed before the relay heard it. */
	dropAcks = false;
	/** Answers every event stream with this status (401: the device was removed). */
	refuseStreams: number | undefined;
	/** A POST of an envelope waits for this to settle before it is answered (to look at the sender's state meanwhile). */
	holdPosts: Promise<void> | undefined;
	failPosts = 0;
	/** Kinds this relay does not know (a relay older than a kind): a POST of one is refused with 422 `unknown-kind`. */
	rejectKinds = new Set<string>();
	/** Invites by hash: who made it, the team, and whether a join request was taken. */
	invites = new Map<string, { team: string; by: string; expires: number; used: boolean }>();
	/** Team tokens `POST /v1/teams` accepts (each once). */
	tokens = new Set<string>();
	/** The join requests the relay took, in order (hash and request bytes). */
	joined: { hash: string; request: Buffer }[] = [];
	private eid = 0;
	private timestamps = new Map<string, number>();

	addTeam(team: Uint8Array, members: string[], entries: RosterEntry[]) {
		this.members.set(hex(team), members);
		this.rosters.set(hex(team), entries);
	}
	/** The ids a device has not acknowledged, in arrival order. */
	pendingFor(device: string): string[] {
		return this.stored.filter((s) => !s.ephemeral && s.to.has(device) && !s.acked.has(device)).map((s) => s.id);
	}
	ackedBy(device: string): string[] {
		return this.stored.filter((s) => s.acked.has(device)).map((s) => s.id);
	}
	/** Ends every open event stream, as a relay restart does; clients reconnect. */
	dropStreams() {
		for (const s of this.streams) this.close(s);
	}
	pushRoster(team: Uint8Array, entry: RosterEntry) {
		this.rosters.get(hex(team))!.push(entry);
		for (const s of this.streams.filter((x) => x.team === hex(team) && !x.closed)) this.send(s, "roster", { seq: entry.seq, hash: hex(entryHash(entry)), entry: Buffer.from(encodeEntry(entry)).toString("base64url") });
	}

	private close(s: Stream) {
		if (s.closed) return;
		s.closed = true;
		try { s.controller.close(); } catch { /* already closed */ }
	}
	private send(s: Stream, event: string, data: unknown, id = ++this.eid) {
		if (s.closed) return;
		s.controller.enqueue(new TextEncoder().encode(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
	}
	private deliver(s: Stream, st: Stored) {
		this.send(s, "envelope", { id: st.id, from: st.envelope.header.from, ephemeral: st.ephemeral, envelope: Buffer.from(encodeEnvelope(st.envelope)).toString("base64url") });
	}

	fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input)), headers = new Headers(init?.headers), device = headers.get("x-straw-device") ?? "";
		const body = init?.body == null ? undefined : (JSON.parse(Buffer.from(init.body as Uint8Array).toString("utf8")) as Record<string, unknown>);
		if (url.pathname === "/v1/teams" && init?.method === "POST") return this.createTeam(body!);
		if (url.pathname === "/v1/invites" && init?.method === "POST") return this.createInvite(device, body!);
		const joining = /^\/v1\/invites\/([0-9a-f]{64})\/join$/.exec(url.pathname);
		if (joining) return this.join(joining[1]!, body!);
		const m = /^\/v1\/teams\/([0-9a-f]{32})\/(envelopes|events|acks|roster)$/.exec(url.pathname);
		if (!m) return json(404, { error: "not-found" });
		const [, team, what] = m as unknown as [string, string, string];
		if (what === "events") return this.events(team, device, init?.signal ?? undefined, headers.get("last-event-id"));
		if (what === "envelopes") return this.post(team, body!);
		if (what === "acks") return this.ack(device, body!);
		if (what === "roster" && init?.method === "POST") return this.appendRoster(team, device, body!);
		if (!(this.members.get(team) ?? []).includes(device)) return json(401, { error: "not-member" });
		const after = url.searchParams.has("after") ? Number(url.searchParams.get("after")) : -1;
		const entries = (this.rosters.get(team) ?? []).filter((e) => e.seq > after);
		const all = this.rosters.get(team) ?? [], head = all.at(-1)!;
		return json(200, { head: { seq: head.seq, hash: hex(entryHash(head)) }, entries: entries.map((e) => ({ seq: e.seq, hash: hex(entryHash(e)), entry: Buffer.from(encodeEntry(e)).toString("base64url") })) });
	};

	private createTeam(body: Record<string, unknown>): Response {
		const team = String(body.team), token = String(body.token);
		if (!this.tokens.delete(token)) return json(401, { error: "bad-token" });
		if (this.rosters.has(team)) return json(409, { error: "team-exists" });
		const entry = decodeEntry(Buffer.from(String(body.entry), "base64url"));
		this.members.set(team, [entry.subject!.record.id]);
		this.rosters.set(team, [entry]);
		return json(201, { team, head: { seq: 0, hash: hex(entryHash(entry)) } });
	}
	private appendRoster(team: string, device: string, body: Record<string, unknown>): Response {
		const log = this.rosters.get(team)!, entry = decodeEntry(Buffer.from(String(body.entry), "base64url")), head = log.at(-1)!;
		if (!(this.members.get(team) ?? []).includes(device)) return json(401, { error: "not-member" });
		if (!Buffer.from(entry.prev).equals(entryHash(head))) return json(409, { error: "conflict", head: { seq: head.seq, hash: hex(entryHash(head)) } });
		const members = this.members.get(team)!;
		if (entry.op === "add") members.push(entry.subject!.record.id);
		if (entry.op === "remove") members.splice(members.indexOf(entry.subject!.record.id), 1);
		this.pushRoster(Buffer.from(team, "hex"), entry);
		return json(201, { seq: entry.seq, hash: hex(entryHash(entry)) });
	}
	private createInvite(device: string, body: Record<string, unknown>): Response {
		const hash = String(body.h);
		if (this.invites.has(hash)) return json(409, { error: "invite-exists" });
		this.invites.set(hash, { team: String(body.team), by: device, expires: Number(body.expires), used: false });
		return json(201, { expires: Number(body.expires) });
	}
	private join(hash: string, body: Record<string, unknown>): Response {
		const inv = this.invites.get(hash);
		if (!inv || inv.expires < Date.now()) return json(404, { error: "no-invite" });
		if (inv.used) return json(409, { error: "invite-used" });
		inv.used = true;
		const request = Buffer.from(String(body.request), "base64url");
		this.joined.push({ hash, request });
		for (const s of this.streams.filter((x) => x.team === inv.team && x.device === inv.by && !x.closed)) this.send(s, "join", { hash, request: request.toString("base64url") });
		return json(202, { queued: true });
	}

	private async post(team: string, body: Record<string, unknown>): Promise<Response> {
		if (this.holdPosts) await this.holdPosts;
		if (this.failPosts > 0) return (this.failPosts--, json(503, { error: "unavailable" }));
		const envelope = parseEnvelope(Buffer.from(String(body.envelope), "base64url"));
		if (!envelope) return json(422, { error: "bad-envelope" });
		if (this.rejectKinds.has(envelope.header.kind)) return json(422, { error: "unknown-kind" });
		const id = hex(envelope.header.id);
		if (this.stored.some((s) => s.id === id)) return json(200, { id, duplicate: true, stale: false });
		const h = envelope.header, members = this.members.get(team) ?? [];
		const to = new Set(h.to.length ? h.to : members.filter((x) => x !== h.from));
		const stale = h.ephemeral && h.ts <= (this.timestamps.get(`${h.from}/${h.kind}`) ?? 0);
		if (h.ephemeral) this.timestamps.set(`${h.from}/${h.kind}`, h.ts);
		const st: Stored = { id, envelope, to, ephemeral: h.ephemeral, acked: new Set() };
		this.stored.push(st);
		for (const s of this.streams.filter((x) => x.team === team && !x.closed && to.has(x.device))) this.deliver(s, st);
		return json(201, { id, duplicate: false, stale });
	}

	private events(team: string, device: string, signal: AbortSignal | undefined, last: string | null): Response {
		if (this.refuseStreams) return json(this.refuseStreams, { error: "not-member" });
		let stream!: Stream;
		const body = new ReadableStream<Uint8Array>({
			start: (controller) => {
				stream = { device, team, controller, closed: false };
				this.streams.push(stream);
				this.opened.push({ device, lastEventId: last });
				// Every queued envelope this device has not acknowledged, whatever the Last-Event-ID.
				for (const st of this.stored) if (!st.ephemeral && st.to.has(device) && !st.acked.has(device)) this.deliver(stream, st);
				signal?.addEventListener("abort", () => { stream.closed = true; try { controller.error(new DOMException("aborted", "AbortError")); } catch { /* closed */ } }, { once: true });
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	private ack(device: string, body: Record<string, unknown>): Response {
		const ids = (body.ids as string[]) ?? [];
		this.acks.push({ device, ids });
		this.onAck?.(device, ids);
		if (this.dropAcks) return json(200, { acked: 0 });
		let n = 0;
		for (const st of this.stored) if (ids.includes(st.id) && !st.acked.has(device)) (st.acked.add(device), n++);
		return json(200, { acked: n });
	}
}
