import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Doc, type Fields, fieldsOk, listenDocs, submitForm } from "./documents.ts";
import { type Answer, type Bus, type Dialog, OWNERS, type OwnerAdapter, type Verdict } from "./owners.ts";
import { type Cmd, listCommands, MAX_PREFIX } from "./commands.ts";
import type { Queued } from "./net.ts";
import { type Editor, probeEditor } from "./probe.ts";
import { MAX_PULL, type Pull, pulled } from "./pull.ts";
import { type Monitor, trackMonitors } from "./monitors.ts";
import { todoOfBranch, type TodoSum } from "./todo.ts";

// The bridge runs in every pi session inside Herdr, subagents included. It turns the owners' dialog events (owners.ts) into one list of open
// dialogs, relays it to the one running GUI server (gui.json in the state directory names its session G), and hands the server's answers to
// the owners. Of ctx.ui it uses only notices and the editor check (getEditorText), and it never judges an answer's meaning: the owner does. Transport is pi-intercom's extension channel
// straw-boss/gui/<sha256(G) prefix>, where only G is owner-eligible: dialogs and acks go to the owner, answers come from it (ownerOnly, and
// checked here against G and the owner's epoch); when G is this session the hub (dialogs.ts) is called in-process instead.
// Per dialog: open → settling (an answer is with the owner) → open again if refused, or closed by the owner's `closed`, the end of its tool
// call, or the session's end. An answer whose verdict does not come within 2 s leaves it `unknown`: later answers get `busy` until it closes.
// The bridge follows gui.json from the session's start (a stat every 2 s), so it is on G's channel whenever a server runs: the key pad's
// Enter guard asks it what the editor would submit (`probe`, probe.ts), and it answers with a class and at most a command name, never the draft. It relays
// the documents the session shows with its dialogs (documents.ts) and hands a form answer for one of them to their owner. The composer's `/` menu
// asks it (`commands`) for the session's commands that match what is typed, and it answers with their names, sources, and descriptions.
// A close button asks it (`close`) to quit its session the way /boss close does (index.ts), which answers whether it will. A stash asks it
// first (`stash-check`, stash.ts) whether the session can be put away and resumed losing nothing; that question never quits anything.
// It relays the session's queue too: pi tells extensions only whether messages wait (hasPendingMessages), so the bridge keeps what it saw
// typed while the agent works (`input` with a streaming behavior) and drops one when its user message starts; a queue pi emptied another
// way (Esc, Alt+Up) clears at the next check. And it relays the session's background monitors (monitors.ts) and its todo list in short (todo.ts), read
// from the branch after each tool call and turn, and after a move in the tree.
// A queue the page takes back (`pull`, pull.ts) is pi's own Alt+Up: the server presses it between a `begin` and a `finish`, and the bridge reads the pulled
// messages off the editor, leaves the draft that was there, and hands over only the messages.
// A secret_drop is answered in the terminal only (SB-F001: intercom identities are self-reported, so a relayed secret dialog could be answered
// into an impostor's hands): the bridge never relays a secret dialog, and refuses any answer to one.

export const REGISTER = "intercom:extension-register";
// pi-intercom has no unregister: every host the session joins stays one of its channels, and the broker takes at most 32 per session (the tab, the viewer, and the hub's own take a few).
const VERDICT_MS = 2000, POLL_MS = 2000, KEEP_MS = 120_000, KEEP = 16, MAX_GUIS = 16, MAX_MESSAGE = 15 * 1024;
/** `finish` waits this long (in 50 ms steps) for pi to take its queue back after the key; a `begin` ticket is good for the same time and more. */
const PULL_WAIT_MS = 1500, PULL_STEP_MS = 50, TICKET_MS = 10_000;
/** At most this many queued messages go to the GUI (the oldest, which are delivered first), each cut to this many characters. */
export const MAX_QUEUED = 5, QUEUED_TEXT = 200;
const clipQueued = (text: string) => (text.length > QUEUED_TEXT ? `${text.slice(0, QUEUED_TEXT - 1)}…` : text);
export const guiNamespace = (g: string) => `straw-boss/gui/${createHash("sha256").update(g).digest("hex").slice(0, 32)}`;
export type Outcome = "accepted" | "rejected" | "stale" | "busy" | "unknown";
export interface Ack { version: 1; type: "ack"; bridgeId: string; id: string; answerId: string; outcome: Outcome; reason?: string; by?: string }
/** `closed`: dialogs closed in the last 2 minutes (at most 16), so an answer that comes late hears who closed it, and a resent one that won, that it won. */
/** `documents`: what the document owner lists now; `docsCut` when they did not fit the message (they are dropped first). `queued`: the session's queue, oldest first. `monitors`: its background monitors. `todo`: its todo list in short. */
export interface Dialogs { version: 1; type: "dialogs"; bridgeId: string; pane: string; file: string | null; dialogs: Dialog[]; closed: Closed[]; documents?: Doc[]; docsCut?: true; queued?: Queued[]; monitors?: Monitor[]; todo?: TodoSum }
export interface Closed { id: string; by: string; answerId?: string }
export interface ProbeResult extends Editor { version: 1; type: "probe-result"; bridgeId: string; probeId: string }
export interface CommandsResult { version: 1; type: "commands-result"; bridgeId: string; reqId: string; commands: Cmd[] }
export interface FormReply { version: 1; type: "form-result"; bridgeId: string; id: string; answerId: string; accepted: boolean; reason?: string }
export interface CloseResult { version: 1; type: "close-result"; bridgeId: string; reqId: string; accepted: boolean; reason?: string }
/** `reason`: why the session cannot be stashed now; none when it can. */
export interface StashCheckResult { version: 1; type: "stash-check-result"; bridgeId: string; reqId: string; reason?: string }
export interface PullResult extends Pull { version: 1; type: "pull-result"; bridgeId: string; reqId: string }
export type ToHub = Dialogs | Ack | ProbeResult | FormReply | CommandsResult | CloseResult | StashCheckResult | PullResult;
export interface FormMessage { version: 1; type: "form"; to: string; id: string; answerId: string; fields: Fields }
/** An answer on the wire: never a secret's `value`. */
export interface AnswerMessage extends Omit<Answer, "value"> { version: 1; type: "answer"; to: string }
/** The hub when it runs in this session: it takes what a remote bridge would publish, from this session's id. */
export interface LocalHub { receive(from: string, msg: ToHub): void }
/** What the hub calls on the bridge of its own session. */
export interface Bridge { deliver(msg: AnswerMessage, reply: (ack: Ack) => void): void; sync(): void; probe(): Editor; commands(prefix: string): Cmd[]; form(msg: FormMessage, reply: (r: FormReply) => void): void; close(keepPane: boolean, ifStashable?: boolean): { accepted: boolean; reason?: string }; stashCheck(): string | undefined; pull(step: "begin" | "finish", ticket?: string): Pull | Promise<Pull> }
interface Channel { snapshot(): { connected: boolean; owner?: { sessionId: string; epoch: string } }; publish(payload: unknown, options?: { audience?: "owner" | "capable" }): void }
interface Rec { adapter: OwnerAdapter; d: Dialog; state: "open" | "settling" | "unknown" | "closed"; answerId?: string; accepted?: boolean; by?: string; at?: number; last?: Ack; waiting: ((ack: Ack) => void)[] }
type Event = { type: string; fromSessionId?: string; owner?: { sessionId: string; epoch: string }; payload?: Record<string, unknown> };

/** `close` quits the session (keeping its pane when `keepPane`), or says why it cannot. */
export function startBridge(pi: ExtensionAPI, { env, dir, local, close }: { env: NodeJS.ProcessEnv; dir: string; local(): LocalHub | undefined; close(keepPane: boolean): string | undefined }): Bridge {
	const bus = pi.events as Bus, bridgeId = randomUUID(), recs = new Map<string, Rec>(), calls = new Map<string, { tool: string; signal?: AbortSignal; stop?: () => void }>();
	const chans = new Map<string, Channel>(), me = () => env.PI_INTERCOM_SESSION_ID ?? "";
	let g: string | undefined, gpid = 0, seen: number | undefined, poll: ReturnType<typeof setInterval> | undefined, offs: (() => void)[] = [], warned = false;
	let file: () => string | undefined = () => undefined, tell = (_text: string) => {}, editor = (): Editor => ({ editor: "unknown" }), docs: Doc[] = [];
	let ticket: { id: string; before: string; at: number } | undefined, ui: Pick<ExtensionContext, "hasUI" | "ui"> | undefined;
	let queued: Queued[] = [], waits = () => false, idle = () => true, todo: TodoSum | undefined, branch = (): readonly unknown[] => [];
	const open = () => [...recs.values()].filter((r) => r.state !== "closed");
	const alive = () => { try { return gpid > 0 && (process.kill(gpid, 0), true); } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } }; // a server that died without removing gui.json gets no probe answers

	// Where the dialogs go: the hub in this process while it runs here, else G's channel while G owns it.
	const target = () => (local() ? me() : g);
	const send = (to: string | undefined, msg: ToHub) => {
		if (to && to === me()) return local()?.receive(to, msg);
		const ch = to ? chans.get(to) : undefined;
		if (ch?.snapshot().connected && ch.snapshot().owner?.sessionId === to) try { ch.publish(msg, { audience: "owner" }); } catch {} // a broker that dropped meanwhile resends on `connection`
	};
	const push = (final = false) => {
		if (!target()) return;
		const dialogs = final ? [] : open().filter((r) => !r.d.secret).map((r) => ({ ...r.d, ...(r.state !== "open" ? { busy: true as const } : {}) }));
		const closed = final ? [] : [...recs.values()].filter((r) => r.state === "closed").map((r) => ({ id: r.d.id, by: r.by!, ...(r.by === "remote" && r.answerId ? { answerId: r.answerId } : {}) }));
		const queue = final ? [] : queued.slice(0, MAX_QUEUED).map((q) => ({ ...q, text: clipQueued(q.text) }));
		const mons = final ? [] : (monitors?.list() ?? []);
		let msg: Dialogs = { version: 1, type: "dialogs", bridgeId, pane: env.HERDR_PANE_ID!, file: file() ?? null, dialogs, closed, documents: final ? [] : docs, ...(queue.length ? { queued: queue } : {}), ...(mons.length ? { monitors: mons } : {}), ...(todo && !final ? { todo } : {}) };
		const big = () => Buffer.byteLength(JSON.stringify(msg)) > MAX_MESSAGE; // in bytes, as the broker counts
		if (big()) msg = { ...msg, documents: [], docsCut: true }; // the documents go first: they stay in the terminal, and the unit says so
		if (big()) msg = { ...msg, dialogs: dialogs.map(({ select, questions, ...d }) => ({ ...d, big: true as const })) }; // shown read-only: too long to show
		send(target(), msg);
	};
	// gui.json names the server's session; it is read at the session's start and then on every mtime change, checked every 2 s (unref'd).
	const follow = () => {
		const at = statSync(join(dir, "gui.json"), { throwIfNoEntry: false })?.mtimeMs ?? 0;
		if (queued.length && !waits()) requeue([]); // pi emptied its queue without delivering (Esc, Alt+Up)
		if (at === seen) return false;
		seen = at;
		try {
			const r = JSON.parse(readFileSync(join(dir, "gui.json"), "utf8")) as { pid?: number; ownerSession?: string };
			[g, gpid] = [r.ownerSession || undefined, Number(r.pid) || 0];
		} catch {
			g = undefined;
		}
		if (g && g !== me() && !chans.has(g) && alive()) join_(g); // a host whose process is gone is not joined: the survivor that takes over rewrites gui.json within moments
		push();
		return true;
	};
	const join_ = (to: string) => {
		if (chans.size >= MAX_GUIS) return void (warned || ((warned = true), tell(`Straw Boss: ${MAX_GUIS} GUI servers came and went in this session; answer its dialogs in the terminal until it restarts`)));
		let ch: Channel | undefined;
		try {
			pi.events.emit(REGISTER, { namespace: guiNamespace(to), ownerEligible: false, onReady: (c: Channel) => (ch = c), onEvent: (e: Event) => ch && onEvent(to, ch, e) });
		} catch {} // pi-intercom missing or refusing: its dialogs stay read-only
		if (ch) chans.set(to, ch);
	};
	const onEvent = (from: string, ch: Channel, e: Event) => {
		if (e.type === "owner" || e.type === "connection") return from === g && push();
		const owner = ch.snapshot().owner, p = e.payload;
		if (p?.type === "probe" || p?.type === "commands" || p?.type === "close" || p?.type === "stash-check") follow(); // a probe goes only to the server gui.json names at this moment
		// Only G's own session, as the broker's current owner of this channel and the server gui.json names now, may answer, probe, or ask for a sync.
		if (e.type !== "message" || p?.version !== 1 || e.fromSessionId !== from || owner?.sessionId !== from || e.owner?.epoch !== owner.epoch) return;
		if (p.type === "sync" && from === g) push();
		// SAFETY: deliver and form check the fields they use before they hand anything to an owner.
		if (p.type === "form" && p.to === bridgeId && from === g) form(p as unknown as FormMessage, (r) => send(from, r));
		if (p.type === "answer" && p.to === bridgeId && from === g) deliver(p as unknown as AnswerMessage, (ack) => send(from, ack));
		if (p.type === "probe" && p.to === bridgeId && from === g && alive() && typeof p.probeId === "string" && p.probeId.length <= 64) send(from, { version: 1, type: "probe-result", bridgeId, probeId: p.probeId, ...editor() });
		if (p.type === "close" && p.to === bridgeId && from === g && alive() && typeof p.reqId === "string" && p.reqId.length <= 64 && typeof p.keepPane === "boolean") send(from, { version: 1, type: "close-result", bridgeId, reqId: p.reqId, ...shut(p.keepPane, p.ifStashable === true) });
		if (p.type === "stash-check" && p.to === bridgeId && from === g && alive() && typeof p.reqId === "string" && p.reqId.length <= 64) send(from, { version: 1, type: "stash-check-result", bridgeId, reqId: p.reqId, ...((r) => (r ? { reason: r } : {}))(stashCheck()) });
		if (p.type === "pull" && p.to === bridgeId && from === g && alive() && typeof p.reqId === "string" && p.reqId.length <= 64 && (p.step === "begin" || (p.step === "finish" && typeof p.ticket === "string" && p.ticket.length <= 64))) void pull(p.step, p.ticket as string | undefined).then((r) => send(from, { version: 1, type: "pull-result", bridgeId, reqId: p.reqId as string, ...r }));
		if (p.type === "commands" && p.to === bridgeId && from === g && alive() && typeof p.reqId === "string" && p.reqId.length <= 64 && typeof p.prefix === "string" && p.prefix.length <= MAX_PREFIX) send(from, { version: 1, type: "commands-result", bridgeId, reqId: p.reqId, commands: listCommands(pi, p.prefix) });
	};
	/** One step of taking the queue back (pull.ts). The editor's text is read and set through ctx.ui, which a session without a UI (print mode) lacks. */
	const text = (): string | undefined => { try { const t = ui?.hasUI ? ui.ui.getEditorText() : undefined; return typeof t === "string" ? t : undefined; } catch { return undefined; } };
	const pull = async (step: "begin" | "finish", id?: string): Promise<Pull> => {
		if (step === "begin") {
			const before = text();
			if (before === undefined) return { reason: "no_editor" };
			if (!waits()) return { pending: false };
			ticket = { id: randomUUID(), before, at: Date.now() };
			return { pending: true, ticket: ticket.id };
		}
		const t = ticket;
		if (!t || t.id !== id || Date.now() - t.at > TICKET_MS) return { reason: "stale" };
		ticket = undefined;
		for (let waited = 0; waits() && waited < PULL_WAIT_MS; waited += PULL_STEP_MS) await new Promise((r) => setTimeout(r, PULL_STEP_MS));
		if (waits()) return { reason: "not_taken" }; // the key did not reach pi's dequeue (another binding?), or pi was busy
		if (queued.length) requeue([]); // the page's queue line goes now, not at the next 2 s check
		const now = text(), got = now === undefined ? undefined : pulled(t.before, now);
		if (!got) return { reason: "no_editor" };
		if ("reason" in got || "empty" in got) return got;
		if (Buffer.byteLength(JSON.stringify(got.text)) > MAX_PULL) return { reason: "too_large" }; // stays in pi's editor
		try { ui!.ui.setEditorText(t.before); } catch { return { reason: "not_cleared" }; } // handing it over while it stays in the editor would send it twice
		return { text: got.text };
	};
	/** Why this session cannot be stashed and resumed as it is now: a turn or a queue, a dialog, or a monitor that a resume would not bring back. */
	const stashCheck = () => {
		const why = [!idle() && "a turn is running", waits() && "messages wait in its queue", open().length > 0 && "a dialog is open", (monitors?.list() ?? []).some((m) => m.status === "running") && "a background monitor is running"].filter(Boolean);
		return why.length ? why.join(", ") : undefined;
	};
	/** `ifStashable`: a stash's close, refused when the session stopped being stashable since its check (a turn started meanwhile). */
	const shut = (keepPane: boolean, ifStashable = false) => {
		const why = (ifStashable && stashCheck()) || close(keepPane);
		return why ? { accepted: false, reason: why } : { accepted: true };
	};
	const changed = () => {
		for (const [id, r] of recs) if (r.state === "closed" && (Date.now() - r.at! > KEEP_MS || recs.size > KEEP)) recs.delete(id);
		if (!follow()) push();
	};

	const report = {
		open(adapter: OwnerAdapter, d: Dialog) {
			const call = d.toolCallId ? calls.get(d.toolCallId) : undefined;
			if (d.toolCallId && (!call || (!adapter.gate && call.tool !== adapter.tool))) return; // only a call in flight of the owner's own tool (a gate: of any tool)
			// A twin (the wrap of ctx.ui, intercept.ts) yields to a contract owner's dialog on the same tool call, whichever opened first: the owner relays it. It is never relayed for a call whose tool has a contract owner, even when the owner's own dialog was refused or never came.
			const same = open().filter((r) => d.toolCallId && r.d.toolCallId === d.toolCallId && Boolean(r.adapter.twin) !== Boolean(adapter.twin));
			if (adapter.twin && (same.length || OWNERS.some((o) => !o.twin && o.tool !== undefined && o.tool === call?.tool))) return; // a tool with a contract owner is relayed by it or stays in the terminal: a twin would lose its notes and localOnly
			same.filter((r) => r.state === "open").forEach((r) => recs.delete(r.d.id));
			recs.set(d.id, { adapter, d, state: "open", waiting: [] });
			if (call?.signal?.aborted) adapter.cancel?.(bus, d);
			changed();
		},
		closed(id: string, by?: string) {
			const r = recs.get(id);
			if (!r || r.state === "closed") return;
			[r.state, r.at, r.by] = ["closed", Date.now(), by ?? (r.accepted ? "remote" : "local")];
			changed();
		},
	};
	const ack = (r: Rec, a: Answer, outcome: Outcome, extra: { reason?: string; by?: string } = {}): Ack => ({ version: 1, type: "ack", bridgeId, id: r.d.id, answerId: a.answerId, outcome, ...extra });
	function deliver(a: AnswerMessage, reply: (ack: Ack) => void) {
		if (typeof a.id !== "string" || typeof a.answerId !== "string" || typeof a.digest !== "string") return;
		const r = recs.get(a.id);
		if (!r) return reply({ version: 1, type: "ack", bridgeId, id: String(a.id), answerId: String(a.answerId), outcome: "stale", by: "gone" });
		if (r.state === "closed") return reply(ack(r, a, r.by === "remote" && r.answerId === a.answerId ? "accepted" : "stale", { by: r.by }));
		if (r.state !== "open") return r.answerId !== a.answerId ? reply(ack(r, a, "busy")) : r.last ? reply(r.last) : void r.waiting.push(reply);
		if (r.d.secret) return reply(ack(r, a, "rejected", { reason: "terminal_only" })); // whatever it carries, a secret is never taken from a relayed answer
		[r.state, r.answerId] = ["settling", a.answerId];
		let off: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined, done = false;
		const finish = (v?: Verdict) => {
			if (done) return;
			done = true;
			off?.(), clearTimeout(timer);
			let out: Ack;
			if (r.state === "closed") out = ack(r, a, r.by === "remote" && r.answerId === a.answerId ? "accepted" : "stale", { by: r.by });
			else if (!v) (r.state = "unknown"), (out = ack(r, a, "unknown"));
			else if (v.accepted) (r.accepted = true), (out = ack(r, a, "accepted"));
			else if (v.reason === "closed") out = ack(r, a, "stale", { by: "local" }); // the owner had settled it already; its close follows
			else (r.state = "open"), (r.answerId = undefined), (out = ack(r, a, "rejected", { reason: v.reason ?? "malformed" }));
			if (r.state !== "open") r.last = out; // what a resend of the same answer gets
			[reply, ...r.waiting.splice(0)].forEach((to) => to(out));
			push();
		};
		try {
			off = r.adapter.answer(bus, r.d, { id: r.d.id, answerId: a.answerId, digest: a.digest, choice: a.choice, answers: Array.isArray(a.answers) ? a.answers : undefined }, finish);
		} catch {
			finish({ accepted: false, reason: "malformed" }); // an answer an adapter could not even map; the owner never saw it
		}
		if (done) return off?.();
		timer = setTimeout(finish, VERDICT_MS);
		push();
	}

	/** A form answer for a listed HTML document goes to its owner, which delivers it as a Chawan submission and replays a repeated answerId. */
	function form(m: FormMessage, reply: (r: FormReply) => void) {
		const out = (r: { accepted: boolean; reason?: string }) => reply({ version: 1, type: "form-result", bridgeId, id: m.id, answerId: m.answerId, ...r });
		if (typeof m.id !== "string" || typeof m.answerId !== "string" || m.answerId.length > 64 || !fieldsOk(m.fields)) return;
		if (docs.some((d) => d.id === m.id && d.kind === "html")) submitForm(bus, m.id, m.answerId, m.fields, out);
		else out({ accepted: false, reason: "closed" });
	}
	let monitors: ReturnType<typeof trackMonitors> | undefined;
	const requeue = (next: Queued[]) => {
		if (next.length === queued.length && next.every((q, i) => q === queued[i])) return;
		queued = next;
		push();
	};
	pi.on("input", (e) => {
		if (e.streamingBehavior) requeue([...queued, { text: e.text, as: e.streamingBehavior }]);
	});
	pi.on("message_start", (e) => {
		const msg = e.message as { role?: string; content?: unknown };
		if (msg.role !== "user" || !queued.length) return;
		const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((b: { type?: string; text?: string }) => (b?.type === "text" ? (b.text ?? "") : "")).join("") : "";
		const i = queued.findIndex((q) => q.text === text); // another extension may have changed the text: then the oldest went
		requeue(queued.filter((_, j) => j !== Math.max(0, i)));
	});
	const retodo = () => {
		const next = todoOfBranch(branch());
		if (JSON.stringify(next) !== JSON.stringify(todo)) ((todo = next), push());
	};
	pi.on("turn_end", retodo);
	pi.on("session_tree", retodo);
	pi.on("session_compact", retodo);
	pi.on("agent_settled", () => {
		if (queued.length && !waits()) requeue([]);
	});
	pi.on("session_start", (_e, ctx) => {
		offs.forEach((off) => off());
		docs = [];
		queued = [];
		waits = () => { try { return ctx.hasPendingMessages(); } catch { return false; } }; // a replaced session's context throws
		idle = () => { try { return ctx.isIdle(); } catch { return false; } };
		file = () => ctx.sessionManager.getSessionFile();
		branch = () => { try { return ctx.sessionManager.getBranch(); } catch { return []; } }; // a replaced session's context throws
		todo = todoOfBranch(branch());
		tell = (text) => ctx.hasUI && ctx.ui.notify(text, "warning");
		editor = () => probeEditor(ctx);
		ui = ctx;
		ticket = undefined;
		monitors = trackMonitors(bus, () => push());
		offs = [...OWNERS.map((o) => o.listen(bus, report)), listenDocs(bus, (d) => ((docs = d), changed())), () => monitors?.off()];
		seen = -1; // a new session file (/new, /resume) is told to the server at once
		follow();
		if (!poll) (poll = setInterval(follow, POLL_MS)).unref?.();
	});
	pi.on("tool_execution_start", (e, ctx) => {
		const signal = ctx.signal, entry: { tool: string; signal?: AbortSignal; stop?: () => void } = { tool: e.toolName, signal };
		const cancel = () => open().filter((r) => r.d.toolCallId === e.toolCallId).forEach((r) => r.adapter.cancel?.(bus, r.d));
		if (signal) (signal.addEventListener("abort", cancel, { once: true }), (entry.stop = () => signal.removeEventListener("abort", cancel)));
		calls.set(e.toolCallId, entry);
	});
	pi.on("tool_execution_end", (e) => {
		calls.get(e.toolCallId)?.stop?.();
		calls.delete(e.toolCallId);
		retodo(); // rpiv-todo writes its state during the call, through any tool that runs it
		open().filter((r) => r.d.toolCallId === e.toolCallId).forEach((r) => report.closed(r.d.id, r.accepted ? "remote" : "error")); // the owner failed to say so
	});
	pi.on("session_shutdown", () => {
		docs = [];
		queued = [];
		todo = undefined;
		monitors?.clear(); // pi-loop-monitor stops a session's monitors with it
		open().forEach((r) => report.closed(r.d.id, "error"));
		push(true);
		[...calls.values()].forEach((c) => c.stop?.());
		calls.clear();
		offs.splice(0).forEach((off) => off());
		(clearInterval(poll), (poll = undefined));
	});
	return { deliver, sync: () => ((seen = -1), follow()), probe: () => editor(), commands: (prefix) => listCommands(pi, prefix), form, close: shut, stashCheck, pull };
}
