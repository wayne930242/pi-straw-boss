import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type OpenCall, type Pending, type Relayed, SECRET, SEVERAL } from "./ask.ts";
import type { Ack, AnswerMessage, Bridge, CloseResult, Dialogs, FormMessage, FormReply, LocalHub, ToHub } from "./bridge.ts";
import { guiNamespace, MAX_QUEUED, QUEUED_TEXT, REGISTER } from "./bridgewire.ts";
import { answerOk, type BlockAnswer, createCaps, type Doc, docsOf, type Fields, fieldsOk, type FormResult, type Shelf } from "./documents.ts";
import type { Session } from "./herdr.ts";
import { canonical } from "./history.ts";
import type { Queued, Ref } from "./net.ts";
import { type Answer, type Answerable, type Dialog, OWNERS, questionsDigest, type Reply, selectDigest, type Then } from "./owners.ts";
import { checkCommands, type Cmd } from "./commands.ts";
import { checkProbe, type Editor } from "./probe.ts";
import { checkPull, type Pull } from "./pull.ts";
import { type Monitor, monitorsOk } from "./monitors.ts";
import { todoOk, type TodoSum } from "./todo.ts";

// The hub, in the session that runs the GUI server: it takes the dialog lists bridges relay (bridge.ts), binds each to the unit on the
// bridge's pane, decides whether the page may answer it, and carries an answer to that bridge. A list counts only from the session intercom
// places on that pane (not the pane the list names, the HERDR_PANE_ID it started with, which Herdr changes when it moves the pane: its sender writes it, so it never vouched for
// anything; docs/specs/2026-11-21-operate-probe.md), for the unit whose session file it names. The page may answer a dialog only when it is the session's one open dialog,
// with no answer on its way, belonging to one of the file's open calls, with a digest that matches its content. A secret_drop is never answerable
// from a page (SB-F001): pi-intercom identities are self-reported, so a same-user process could pose as the asking session's bridge, relay a secret
// dialog under its own key, and receive the value sealed to it. A secret dialog, or any other dialog beside a secret_drop, stays in the terminal until
// intercom can verify who a bridge is; seal.ts keeps the envelope for then, and nothing here takes, seals, or sends a secret's value.
// The same binding, for every bridge whether it holds a dialog or not, tells where to ask what a session's editor would submit (`probe`) and
// which of its commands match a `/` typed in the composer (`commands`), takes its queue back for the composer (`pull`, in two steps around the key, pull.ts), and
// gives the unit the documents its bridge lists, each by a capability (documents.ts), and carries a form answer for one to that bridge.

export const PULL_MS = 4000, PULL_BUDGET_MS = 2500;
export const PROBE_MS = 1000, PROBE_AGAIN_MS = 3000;
const ACK_MS = 5000, FORM_MS = 5000, KEEP_MS = 600_000, KEEP = 256, MAX_TEXT = 8192, MAX_NOTE = 2048, MAX_ALL = 12_288;
export const ANSWER_ID = /^[A-Za-z0-9_-]{16,64}$/, CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
interface Channel { snapshot(): { connected: boolean; owner?: { sessionId: string; epoch: string } }; publish(payload: unknown, options?: { audience?: "owner" | "capable"; ownerOnly?: boolean }): void }
type Event = { type: string; fromSessionId?: string; sessionId?: string; owner?: { sessionId: string; epoch: string }; payload?: unknown };
/** Where an answer for a unit goes: its bridge, in the session `from`. */
export interface Target { from: string; bridgeId: string; answer: Answerable }
/** A dialog the hub's last reading made answerable (not a secret, not terminal-only): the unit key, its owner, and where an answer goes. The sb server forwards these to a controller (src/link/dialogs-out.ts). */
export interface Offer { key: string; owner: string; target: Target }
/** Whether a dialog is still listed by a bridge; when not, who closed it (`remote` for an answer the hub carried, `local` for the terminal, else what the bridge said), `gone` when its bridge left or never said. */
export type Outcome = { open: true } | { open: false; by: string };
export interface Sent { status: number; body: { outcome: string; reason?: string; by?: string; then?: Then } }
export type Hub = ReturnType<typeof createHub>;
/**
 * A gate (src/link/gate.ts) or an approval (src/link/approval.ts) that the hub saw open on a bridge and then close with an explicit yes: the sb server takes an ally run's gated tool call only against one
 * (docs/specs/2026-10-26-sb-backend.md, Tower tools in a run, The gate's Allow). `from` is the bridge's session and `pane` the pane it relays for; the server checks that the broker places that session on the run's pane.
 */
export interface AllowNote { from: string; pane: string; owner: string; dialogId: string; toolCallId: string; title: string; at: number }
/** The owners whose explicit yes is an Allow, and how many open ones the hub remembers per bridge. */
const ALLOWING = new Set(["straw-link-gate", "straw-link-request"]);
const KEEP_OPEN = 32;

const str = (v: unknown): v is string => typeof v === "string";
const opt = (v: unknown) => v === undefined || str(v);
/** Waits up to `ms` for the reply filed under `k`; undefined when none came (or the hub stopped). */
const wait = <T>(map: Map<string, (x?: T) => void>, k: string, ms: number) => new Promise<T | undefined>((resolve) => {
	const timer = setTimeout(() => settle(), ms), settle = (x?: T) => (clearTimeout(timer), map.delete(k), resolve(x));
	map.set(k, settle);
});
/** A relayed dialog, checked so a malformed message cannot break the net reading. */
const valid = (d: Dialog) => str(d?.owner) && str(d.id) && d.id.length <= 64 && /^[0-9a-f]{64}$/.test(String(d.digest)) && opt(d.toolCallId) &&
	(d.secret === undefined || (str(d.secret?.label) && Array.isArray(d.secret.instructions) && d.secret.instructions.every(str) && opt(d.secret.url) && str(d.secret.destination))) &&
	(d.select === undefined || (str(d.select?.title) && Array.isArray(d.select.choices) && d.select.choices.every((c) => str(c?.label) && opt(c.note) && (c.next === undefined || c.next === "terminal" || c.next === "pane") && (c.tagged === undefined || (c.tagged === true && c.next === "pane"))) && opt(d.select.copy))) &&
	(d.questions === undefined || (Array.isArray(d.questions) && d.questions.every((q) => str(q?.question) && opt(q.header) && typeof q.multiple === "boolean" && Array.isArray(q.options) && q.options.every((o) => str(o?.title) && opt(o.description)))));
/** Own words or a note as they would be typed: CRLF to LF, never blank, within `max` bytes, no control characters but tab and newline. */
const words = (v: unknown, max: number) => (str(v) && v.trim() && Buffer.byteLength(v) <= max && !CONTROL.test(v.replace(/\r\n?/g, "\n")) ? v.replace(/\r\n?/g, "\n") : null);

/** The page's answer checked against what it may answer: one choice of a select (a local-only one too, from any page), one entry per question, or a cancel (only for a dialog whose owner takes one, and with nothing else). A secret's value is never taken from any page (SB-F001; see the header). */
export function checkAnswer(t: Answerable, json: Record<string, unknown>): { choice: number } | { answers: Reply[] } | { cancel: true } | string {
	const { choice, answers, value, cancel } = json;
	if (value !== undefined) return "A secret cannot be entered here; answer it in the terminal.";
	if (cancel !== undefined) {
		if (cancel !== true || choice !== undefined || answers !== undefined) return "A cancel carries nothing else.";
		return t.cancel ? { cancel: true } : "This dialog cannot be cancelled from here; cancel it in the terminal.";
	}
	if (t.select) {
		if (answers !== undefined || !Number.isInteger(choice) || (choice as number) < 0 || (choice as number) >= t.select.choices.length) return "Pick one of its choices.";
		return { choice: choice as number };
	}
	const qs = t.questions ?? [], out: Reply[] = [];
	if (choice !== undefined || !Array.isArray(answers) || answers.length !== qs.length) return "Answer every question.";
	for (const [i, q] of qs.entries()) {
		const r = (answers[i] ?? {}) as Record<string, unknown>, picks = (r.choices ?? []) as number[], n = `Question ${i + 1}: `;
		if (!Array.isArray(picks) || new Set(picks).size !== picks.length || !picks.every((p) => Number.isInteger(p) && p >= 0 && p < q.options.length) || (!q.multiple && picks.length > 1)) return `${n}pick from its options.`;
		const text = r.text === undefined ? undefined : words(r.text, MAX_TEXT), note = r.note === undefined || r.note === "" ? undefined : words(r.note, MAX_NOTE);
		if (text === null || note === null) return `${n}the text is blank, too long, or has control characters.`;
		if (!picks.length && text === undefined) return `${n}pick an option or write your own answer.`;
		if (!q.multiple && picks.length && text !== undefined) return `${n}pick an option or write your own answer, not both.`;
		out.push({ ...(picks.length ? { choices: picks } : {}), ...(text !== undefined ? { text } : {}), ...(note ? { note } : {}) });
	}
	return Buffer.byteLength(JSON.stringify(out)) > MAX_ALL ? "The answers are too long together." : { answers: out };
}

export function createHub(pi: ExtensionAPI, me: string, local: Bridge, onAllow?: (note: AllowNote) => void) {
	// `active`: a page listens (start/stop). `tracking`: the sb server keeps the hub's channel and gate tracking up whether or not a page listens, so the Allows of an ally run's gated calls (allows.ts)
	// are noted after `/boss gui stop` and when no GUI could start (track()).
	let channel: Channel | undefined, epoch: string | undefined, active = false, tracking = false, change = () => {};
	/** Subscribers that hear of every bridge change whether or not a page listens (`onChange`). */
	const watchers = new Set<() => void>();
	const changed = () => {
		change();
		for (const w of [...watchers]) try { w(); } catch { /* a subscriber must not break the relay */ }
	};
	let bound = new Map<string, { from: string; b: Dialogs }>(), targets = new Map<string, Target>(), reach = new Map<string, { from: string; bridgeId: string }>(), placed = new Map<string, string>();
	const bridges = new Map<string, Dialogs>(), waiting = new Map<string, (ack?: Ack) => void>(), done = new Map<string, { key: string; at: number; sent: Sent }>(), probes = new Map<string, (e?: Editor) => void>(), lists = new Map<string, (c?: Cmd[]) => void>(), pulls = new Map<string, (p?: Pull) => void>();
	const closes = new Map<string, (r?: Pick<CloseResult, "accepted" | "reason">) => void>(), checks = new Map<string, (r?: { reason?: string }) => void>();
	const caps = createCaps(), forms = new Map<string, (r?: FormReply) => void>();
	/** The gates and approvals each bridge has open (the last lists), so a close with `allow` can be told what it allowed. */
	const gates = new Map<string, Map<string, AllowNote>>();
	const noteAllows = (from: string, msg: Dialogs) => {
		const open = gates.get(from) ?? new Map<string, AllowNote>();
		for (const c of msg.closed) {
			const n = open.get(c.id);
			if (n && c.allow === true && n.pane === msg.pane) try { onAllow?.(n); } catch { /* the server's registry must not break the relay */ }
			open.delete(c.id);
		}
		for (const d of msg.dialogs) {
			if (!ALLOWING.has(d.owner) || !d.toolCallId || !d.select) continue;
			open.delete(d.id);
			open.set(d.id, { from, pane: msg.pane, owner: d.owner, dialogId: d.id, toolCallId: d.toolCallId, title: d.select.title, at: Date.now() });
		}
		while (open.size > KEEP_OPEN) open.delete(open.keys().next().value!);
		if (open.size) gates.set(from, open);
		else gates.delete(from);
	};
	let shelves = new Map<string, Shelf>();
	const owner = () => channel?.snapshot().owner?.sessionId === me;
	const sync = () => {
		local.sync();
		if (owner()) try { channel!.publish({ version: 1, type: "sync" }, { audience: "capable", ownerOnly: true }); } catch {} // a broker that dropped meanwhile elects again, which syncs
	};
	const join = () => {
		try {
			if (!channel && me) pi.events.emit(REGISTER, { namespace: guiNamespace(me), ownerEligible: true, onReady: (c: Channel) => (channel = c), onEvent });
		} catch {
			// No channel: only this session's own dialogs can be answered (in-process), every other one stays read-only.
		}
		epoch = channel?.snapshot().owner?.epoch;
		sync();
	};
	const receive = (from: string, msg: ToHub) => {
		if (!(active || tracking) || msg?.version !== 1 || !str(msg.bridgeId)) return;
		const closed = msg.type === "dialogs" && Array.isArray(msg.closed) && msg.closed.length <= 16 && msg.closed.every((c) => str(c?.id) && str(c.by) && opt(c.answerId) && (c.allow === undefined || c.allow === true));
		const docs = msg.type === "dialogs" && (msg.documents === undefined ? [] : docsOf({ version: 1, documents: msg.documents })); // documents out of shape go alone, as if cut
		// A queue out of shape is left out; the dialogs and documents still go.
		const queued = msg.type === "dialogs" && Array.isArray(msg.queued) && msg.queued.length <= MAX_QUEUED && msg.queued.every((q) => typeof q?.text === "string" && q.text.length <= QUEUED_TEXT && (q.as === "steer" || q.as === "followUp")) ? msg.queued.map(({ text, as }) => ({ text, as })) : undefined;
		const monitors = msg.type === "dialogs" && monitorsOk(msg.monitors) ? msg.monitors.map(({ id, what, status, exit, last, load, lines, at, ended }) => ({ id, what, status, exit, last, load, lines, at, ended })) : undefined;
		const todo = msg.type === "dialogs" && todoOk(msg.todo) ? { done: msg.todo.done, total: msg.todo.total, ...(msg.todo.now && { now: msg.todo.now }), ...(msg.todo.graph && { graph: msg.todo.graph }), ...(msg.todo.steps && { steps: msg.todo.steps.map(({ id, kind, status, name, round, outcome }) => ({ id, kind, status, ...(name !== undefined && { name }), ...(round !== undefined && { round }), ...(outcome && { outcome }) })) }) } : undefined;
		if (closed && str(msg.pane) && (msg.file === null || str(msg.file)) && Array.isArray(msg.dialogs) && msg.dialogs.every(valid)) (noteAllows(from, msg), bridges.set(from, { ...msg, ...(docs ? { documents: docs } : { documents: [], docsCut: true as const }), queued, monitors, todo }), changed());
		if (msg.type === "ack") waiting.get([from, msg.bridgeId, msg.id, msg.answerId].join("\n"))?.(msg);
		if (msg.type === "probe-result") probes.get([from, msg.bridgeId, msg.probeId].join("\n"))?.(checkProbe({ ...msg }));
		if (msg.type === "pull-result" && str(msg.reqId)) pulls.get([from, msg.bridgeId, msg.reqId].join("\n"))?.(checkPull({ ...msg }));
		if (msg.type === "commands-result" && str(msg.reqId)) lists.get([from, msg.bridgeId, msg.reqId].join("\n"))?.(checkCommands(msg.commands));
		if (msg.type === "close-result" && str(msg.reqId) && typeof msg.accepted === "boolean" && opt(msg.reason) && (msg.reason?.length ?? 0) <= 512) closes.get([from, msg.bridgeId, msg.reqId].join("\n"))?.({ accepted: msg.accepted, ...(msg.reason ? { reason: msg.reason } : {}) });
		if (msg.type === "stash-check-result" && str(msg.reqId) && opt(msg.reason) && (msg.reason?.length ?? 0) <= 512) checks.get([from, msg.bridgeId, msg.reqId].join("\n"))?.(msg.reason ? { reason: msg.reason } : {});
		if (msg.type === "form-result" && typeof msg.accepted === "boolean" && opt(msg.reason) && (msg.reason?.length ?? 0) <= 512) forms.get([from, msg.bridgeId, msg.id, msg.answerId].join("\n"))?.(msg);
	};
	const onEvent = (e: Event) => {
		if (e.type === "owner" && e.owner?.sessionId === me && e.owner.epoch !== epoch && (epoch = e.owner.epoch) && (active || tracking)) sync();
		if (e.type === "message" && e.fromSessionId) receive(e.fromSessionId, e.payload as ToHub);
		if (e.type === "session_left" && e.sessionId) {
			gates.delete(e.sessionId);
			if (bridges.delete(e.sessionId)) changed();
		}
	};
	/** One question to the bridge bound to `key`'s pane and file (this session's answers in-process): undefined with no such bridge or no answer within `ms`, or with `again` sent once more at `ms` under the same id and waited on that much longer (the first answer to either send is taken). */
	const request = async <T>(key: string, map: Map<string, (x?: T) => void>, mine: () => T | undefined | Promise<T | undefined>, msg: (id: string) => Record<string, unknown>, ms = PROBE_MS, again = 0): Promise<T | undefined> => {
		const t = reach.get(key);
		if (!t || !active) return undefined;
		if (t.from === me) return mine();
		const id = randomUUID(), k = [t.from, t.bridgeId, id].join("\n"), got = wait(map, k, ms + again);
		const ask = () => {
			try {
				if (!owner()) throw new Error("not the owner");
				channel!.publish({ version: 1, to: t.bridgeId, ...msg(id) }, { audience: "capable", ownerOnly: true });
			} catch {
				map.get(k)?.(); // unreachable: no answer
			}
		};
		ask();
		const timer = again && map.has(k) ? setTimeout(() => map.has(k) && ask(), ms) : undefined;
		void got.then(() => clearTimeout(timer));
		return got;
	};
	// `calls`: the file's open calls (several when its newest assistant message left more than one unanswered); without them, the file's one call.
	const merge = (key: string, file: Pending | undefined, ds: Dialog[], readable: boolean, calls: OpenCall[] = file && file.why !== SEVERAL ? [{ id: file.callId, name: file.tool }] : []): Pending => {
		const d = ds[0]!, adapter = OWNERS.find((o) => o.name === d.owner), base = file ?? { callId: d.toolCallId ?? d.id, tool: adapter?.tool ?? "dialog" }, at = bound.get(key)!;
		const terminal = (why: string): Pending => ({ ...base, why });
		// A secret_drop open anywhere, or a secret dialog, keeps everything in the terminal (SB-F001).
		if (d.secret || file?.tool === "secret_drop" || calls.some((c) => c.name === "secret_drop")) return file?.tool === "secret_drop" ? file : terminal(SECRET);
		if (ds.length !== 1) return terminal(SEVERAL);
		if (d.big) return terminal("It is too long to show here; answer it in the terminal.");
		// A dialog naming a tool call answers only for one of the open calls: of its owner's own tool, or of any tool when the owner is a gate (which must name one).
		const call = d.toolCallId ? calls.find((c) => c.id === d.toolCallId) : undefined;
		if (!adapter || !readable || (d.toolCallId ? !call || !(adapter.gate || call.name === adapter.tool) : adapter.gate)) return terminal(base.why ?? "Answer it in the terminal.");
		if ((d.select ? selectDigest(d.select) : d.questions ? questionsDigest(d.questions) : undefined) !== d.digest) return terminal("The question here differs from the one in the terminal; answer it there.");
		const answer: Answerable = { dialog: d.id, digest: d.digest, ...(d.command === true ? { command: true as const } : {}), ...(adapter.twin ? { twin: true as const } : {}), ...(adapter.cancellable && d.cancellable === true ? { cancel: true as const } : {}), ...(d.select ? { select: d.select } : { questions: d.questions }) }, { why: _, ...kept } = base;
		const rest = call && call.id !== base.callId ? { callId: call.id, tool: call.name } : kept; // the file's question belongs to its first call, not to another one the dialog is bound to
		// While an answer is on its way the page shows it read-only, but the bridge still hears that answer resent (Check again: it replays) and any other (busy).
		targets.set(key, { from: at.from, bridgeId: at.b.bridgeId, answer });
		return d.busy ? terminal("An answer is on its way; check the terminal.") : { ...rest, answer };
	};
	const hub: LocalHub & {
		readonly running: boolean; readonly me: string; onChange(cb: () => void): () => void; answerable(): Offer[]; monitors(): { pane: string; what: string }[]; outcome(dialogId: string): Outcome; start(onChange: () => void): void; track(): void; stop(): void; relayed(sessions: Session[], refs: Map<string, Ref>): Relayed; target(key: string): Target | undefined;
		has(key: string, owner: string, at?: { pane?: string; file?: string }): boolean; replay(answerId: string, key: string): Sent | undefined; ended(key: string, dialog: string, answerId: string): Sent | undefined; send(key: string, t: Target, a: Answer): Promise<Sent>;
		probe(key: string, nonce?: string, flags?: boolean): Promise<Editor | undefined>; pull(key: string, step: "begin" | "finish", ref?: string): Promise<Pull | undefined>; commands(key: string, prefix: string): Promise<Cmd[] | undefined>; close(key: string, keepPane: boolean, ifStashable?: boolean): Promise<{ accepted: boolean; reason?: string } | undefined>; stashCheck(key: string): Promise<{ reason?: string } | undefined>; doc(cap: string): { key: string; doc: Doc } | undefined; form(cap: string, answerId: string, fields: Fields, answer?: BlockAnswer): Promise<FormResult | undefined>;
	} = {
		receive,
		/** Whether the bridge bound to `key` relays an open dialog of `owner` (a signal from the runtime that owns the approval, not from the session file). With `at` (the unit's pane and file) the bridges are read directly too, so a dialog relayed since the last net reading counts at once, on the pane intercom placed it on at that reading or the one it names (a guard's signal: a match only adds a refusal). */
		has: (key, owner, at) => Boolean(bound.get(key)?.b.dialogs.some((d) => d.owner === owner)) || Boolean(at?.pane && at.file && [...bridges].some(([from, b]) => (b.pane === at.pane || placed.get(from) === at.pane) && canonical(b.file ?? undefined) === canonical(at.file) && b.dialogs.some((d) => d.owner === owner))),
		get running() { return active; },
		me,
		/** Calls `cb` after each change in what bridges relay, with or without a page (`track` suffices); returns the way to stop. */
		onChange(cb) {
			watchers.add(cb);
			return () => void watchers.delete(cb);
		},
		/** The dialogs the last `relayed` reading + `merge` made answerable, each with where an answer goes. */
		answerable: () => [...targets].flatMap(([key, target]) => {
			const d = bound.get(key)?.b.dialogs.find((x) => x.id === target.answer.dialog);
			return d ? [{ key, owner: d.owner, target }] : [];
		}),
		/** Read from the bridges' own lists, not from the last binding, so a reading that is half done never reads as a close. */
		outcome(dialogId) {
			let by: string | undefined;
			for (const b of bridges.values()) {
				if (b.dialogs.some((d) => d.id === dialogId)) return { open: true };
				by ??= b.closed.find((c) => c.id === dialogId)?.by;
			}
			return { open: false, by: by ?? "gone" };
		},
		/** The channel is registered at the first start, before gui.json names this session; later starts in this process reuse it. */
		start(onChange) {
			[change, active] = [onChange, true];
			join();
		},
		/** The server keeps the channel and the gates' tracking up with no page listening, and through a page's stop; bridges relay to it as soon as it owns the channel. */
		track() {
			tracking = true;
			join();
		},
		stop() {
			active = false;
			change = () => {};
			[bridges, bound, targets, reach, placed, shelves, gates].forEach((m) => m.clear());
			caps.clear(); // a capability lives as long as its server
			[...waiting.values(), ...probes.values(), ...lists.values(), ...pulls.values(), ...forms.values(), ...closes.values(), ...checks.values()].forEach((w) => w());
			// What was relayed is gone with the page's state: the bridges are asked for their open dialogs again, so a gate still open is known when it closes.
			if (tracking) sync();
		},
		/** The monitors that run in the sessions that relayed to this hub, with the pane each runs in (the sb server tells its controllers which units have background work). */
		monitors: () => [...bridges.values()].flatMap((b) => (b.monitors ?? []).filter((x) => x.status === "running").map((x) => ({ pane: b.pane, what: x.what }))),
		/** Binds each relayed list to a unit, from this net reading's sessions and registry. */
		relayed(sessions, refs) {
			[bound, targets, reach, placed] = [new Map(), new Map(), new Map(), new Map()];
			const shelved: { key: string; from: string; bridgeId: string; docs: Doc[] }[] = [], cut = new Set<string>(), queues = new Map<string, Queued[]>(), mons = new Map<string, Monitor[]>(), todos = new Map<string, TodoSum>();
			for (const [from, b] of bridges) {
				const pane = sessions.find((s) => s.id === from)?.herdrLocation?.paneId, file = pane ? canonical(b.file ?? undefined) : undefined;
				if (pane) placed.set(from, pane);
				const ref = file && [...refs.values()].find((r) => r.pane === pane && r.file === file);
				if (ref) (reach.set(ref.key, { from, bridgeId: b.bridgeId }), shelved.push({ key: ref.key, from, bridgeId: b.bridgeId, docs: b.documents ?? [] }), b.docsCut && cut.add(ref.key));
				if (ref && b.queued?.length) queues.set(ref.key, b.queued);
				if (ref && b.monitors?.length) mons.set(ref.key, b.monitors);
				if (ref && b.todo) todos.set(ref.key, b.todo);
				if (ref && (b.dialogs.length || b.closed.length)) bound.set(ref.key, { from, b });
			}
			const cards = caps.bind(shelved, new Set([...bridges].flatMap(([from, b]) => (b.documents ?? []).map((d) => `${from}\n${b.bridgeId}\n${d.id}`))));
			shelves = new Map([...cards].flatMap(([key, docs]): [string, Shelf][] => (docs.length || cut.has(key) ? [[key, { ...(docs.length ? { docs } : {}), ...(cut.has(key) ? { docsCut: true as const } : {}) }]] : [])));
			return { dialogsOf: (key) => bound.get(key)?.b.dialogs, merge, docsOf: (key) => shelves.get(key), queuedOf: (key) => queues.get(key), monitorsOf: (key) => mons.get(key), todoOf: (key) => todos.get(key) };
		},
		/** How a dialog that is no longer open here ended: `accepted` for the answer that won it, else `stale` with who closed it. */
		ended(key, dialog, answerId) {
			const c = bound.get(key)?.b.closed.find((x) => x.id === dialog);
			return c && { status: 200, body: c.by === "remote" && c.answerId === answerId ? { outcome: "accepted" } : { outcome: "stale", by: c.by } };
		},
		target: (key) => targets.get(key),
		replay(answerId, key) {
			const hit = done.get(answerId);
			return hit?.key === key && Date.now() - hit.at < KEEP_MS ? hit.sent : undefined;
		},
		/** Publishes the answer to its bridge (or calls this session's) and waits up to 5 s for the bridge's ack. A secret's value is never sent (SB-F001). */
		async send(key, t, { value, ...a }) {
			if (value !== undefined) return { status: 409, body: { outcome: "unsent", reason: "A secret cannot be entered here; nothing was sent. Enter it in the terminal." } };
			const k = [t.from, t.bridgeId, a.id, a.answerId].join("\n");
			const msg: AnswerMessage = { version: 1, type: "answer", to: t.bridgeId, ...a };
			const ack = wait(waiting, k, ACK_MS);
			try {
				if (t.from === me) local.deliver(msg, (x) => receive(me, x));
				else if (owner()) channel!.publish(msg, { audience: "capable", ownerOnly: true });
				else throw new Error("not the owner");
			} catch {
				waiting.get(k)?.();
				return { status: 503, body: { outcome: "unsent", reason: "The session could not be reached; nothing was sent." } };
			}
			const x = await ack;
			if (!x) return { status: 504, body: { outcome: "unknown", reason: "The session did not confirm the answer; check the terminal." } };
			const sent = { status: 200, body: { outcome: x.outcome, ...(x.reason ? { reason: x.reason } : {}), ...(x.by ? { by: x.by } : {}) } };
			if (["accepted", "rejected", "stale"].includes(x.outcome)) done.set(a.answerId, { key, at: Date.now(), sent });
			for (const [id, old] of done) if (done.size > KEEP || Date.now() - old.at > KEEP_MS) done.delete(id);
			return sent;
		},
		/** What the session's editor would submit; undefined for no answer, which is not `unknown` (docs/specs/2026-11-21-operate-probe.md). A turn or a loaded machine can hold the bridge past a second, so it is asked again at 1 s and waited on 3 s more (4 s at most, well inside the link's 20 s and Herdr's 15 s); a probe only reads, so the resend changes nothing there. */
		probe: (key, nonce, flags) => request(key, probes, () => checkProbe({ ...local.probe(nonce, flags) }), (probeId) => ({ type: "probe", probeId, ...(nonce && { nonce }), ...(flags && { flags: true }) }), PROBE_MS, PROBE_AGAIN_MS),
		/**
		 * One step of taking the session's queue back (pull.ts): `begin` carries the page's `take` id, `finish` the ticket. The bridge may spend 1.5 s on `finish`
		 * and is told to answer within `PULL_BUDGET_MS` of now (the clock is this machine's) or clear nothing; the hub waits longer than that, so an answer that
		 * cleared pi's editor is never one nobody waits for.
		 */
		pull: (key, step, ref) => {
			const deadline = Date.now() + PULL_BUDGET_MS;
			return request(key, pulls, () => Promise.resolve(local.pull(step, ref, deadline)).then((r) => checkPull({ ...r })), (reqId) => ({ type: "pull", reqId, step, ...(step === "begin" ? (ref ? { take: ref } : {}) : { ticket: ref, deadline }) }), step === "finish" ? PULL_MS : PROBE_MS);
		},
		/** The session's commands that match `prefix`, as its bridge lists them. */
		/** Asks the session to quit as /boss close does (keeping its pane when `keepPane`); undefined when its bridge did not answer. */
		close: (key, keepPane, ifStashable = false) => request(key, closes, () => local.close(keepPane, ifStashable), (reqId) => ({ type: "close", reqId, keepPane, ...(ifStashable ? { ifStashable } : {}) })),
		/** Whether the session can be stashed (stash.ts): `{}` when it can, a reason when not, undefined when its bridge did not answer. */
		stashCheck: (key) => request(key, checks, () => ((r) => (r ? { reason: r } : {}))(local.stashCheck()), (reqId) => ({ type: "stash-check", reqId })),
		commands: (key, prefix) => request(key, lists, () => checkCommands(local.commands(prefix)), (reqId) => ({ type: "commands", reqId, prefix })),
		/** A listed document by its capability, as its bridge lists it now (a list that changed since the reading counts, a bridge that left does not). */
		doc(cap) {
			const at = caps.find(cap), b = at && bridges.get(at.from), doc = at && b?.bridgeId === at.bridgeId ? b.documents?.find((d) => d.id === at.id) : undefined;
			return doc && { key: at!.key, doc };
		},
		/** A form answer for the document `cap`, to its bridge (or this session's), waiting up to 5 s for the owner's result. One answerId is sent once (docs.ts spends its nonce first). */
		async form(cap, answerId, fields, answer) {
			const at = caps.find(cap), k = at && [at.from, at.bridgeId, at.id, answerId].join("\n");
			if (!ANSWER_ID.test(answerId) || !fieldsOk(fields) || (answer !== undefined && !answerOk(answer))) return { accepted: false, reason: "invalid" };
			if (!at || !k || !active || !hub.doc(cap)) return { accepted: false, reason: "closed" };
			const msg: FormMessage = { version: 1, type: "form", to: at.bridgeId, id: at.id, answerId, fields, ...(answer ? { answer } : {}) }, got = wait(forms, k, FORM_MS);
			try {
				if (at.from === me) local.form(msg, (r) => receive(me, r));
				else if (owner()) channel!.publish(msg, { audience: "capable", ownerOnly: true });
				else throw new Error("not the owner");
			} catch {
				forms.get(k)?.(); // unreachable: not confirmed
			}
			const r = await got;
			return r && { accepted: r.accepted, ...(str(r.reason) ? { reason: r.reason } : {}) };
		},
	};
	return hub;
}
