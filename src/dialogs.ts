import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Pending, type Relayed, SEVERAL } from "./ask.ts";
import { type Ack, type AnswerMessage, type Bridge, type Dialogs, guiNamespace, type LocalHub, REGISTER, type ToHub } from "./bridge.ts";
import type { Session } from "./herdr.ts";
import { canonical } from "./history.ts";
import type { Ref } from "./net.ts";
import { type Answerable, type Dialog, OWNERS, questionsDigest, type Reply, selectDigest } from "./owners.ts";
import { checkProbe, type Editor } from "./probe.ts";

// The hub, in the session that runs the GUI server: it takes the dialog lists bridges relay (bridge.ts), binds each to the unit on the
// bridge's pane, decides whether the page may answer it, and carries an answer to that bridge. A list counts only from the session intercom
// places on that pane, for the unit whose session file it names. The page may answer a dialog only when it is the session's one open dialog,
// with no answer on its way, belonging to the file's one open call (never a secret_drop), with a digest that matches its content.
// The same binding, for every bridge whether it holds a dialog or not, tells where to ask what a session's editor would submit (`probe`).

const ACK_MS = 5000, PROBE_MS = 1000, KEEP_MS = 600_000, KEEP = 256, MAX_TEXT = 8192, MAX_NOTE = 2048, MAX_ALL = 12_288;
export const ANSWER_ID = /^[A-Za-z0-9_-]{16,64}$/, CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
interface Channel { snapshot(): { connected: boolean; owner?: { sessionId: string; epoch: string } }; publish(payload: unknown, options?: { audience?: "owner" | "capable"; ownerOnly?: boolean }): void }
type Event = { type: string; fromSessionId?: string; sessionId?: string; owner?: { sessionId: string; epoch: string }; payload?: unknown };
/** Where an answer for a unit goes: its bridge, in the session `from`. */
export interface Target { from: string; bridgeId: string; answer: Answerable }
export interface Sent { status: number; body: { outcome: string; reason?: string; by?: string } }
export type Hub = ReturnType<typeof createHub>;

const str = (v: unknown): v is string => typeof v === "string";
const opt = (v: unknown) => v === undefined || str(v);
/** A relayed dialog, checked so a malformed message cannot break the net reading. */
const valid = (d: Dialog) => str(d?.owner) && str(d.id) && d.id.length <= 64 && /^[0-9a-f]{64}$/.test(String(d.digest)) && opt(d.toolCallId) &&
	(d.select === undefined || (str(d.select?.title) && Array.isArray(d.select.choices) && d.select.choices.every((c) => str(c?.label) && opt(c.note)) && opt(d.select.copy))) &&
	(d.questions === undefined || (Array.isArray(d.questions) && d.questions.every((q) => str(q?.question) && opt(q.header) && typeof q.multiple === "boolean" && Array.isArray(q.options) && q.options.every((o) => str(o?.title) && opt(o.description)))));
/** Own words or a note as they would be typed: CRLF to LF, never blank, within `max` bytes, no control characters but tab and newline. */
const words = (v: unknown, max: number) => (str(v) && v.trim() && Buffer.byteLength(v) <= max && !CONTROL.test(v.replace(/\r\n?/g, "\n")) ? v.replace(/\r\n?/g, "\n") : null);

/** The page's answer checked against what it may answer: one choice of a select (not a local-only one from a remote page), or one entry per question. */
export function checkAnswer(t: Answerable, json: Record<string, unknown>, remote: boolean): { choice: number } | { answers: Reply[] } | string {
	const { choice, answers } = json;
	if (t.select) {
		if (answers !== undefined || !Number.isInteger(choice) || (choice as number) < 0 || (choice as number) >= t.select.choices.length) return "Pick one of its choices.";
		return remote && t.select.choices[choice as number]!.localOnly ? "That choice acts on the computer the GUI runs on; pick it there." : { choice: choice as number };
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

export function createHub(pi: ExtensionAPI, me: string, local: Bridge) {
	let channel: Channel | undefined, epoch: string | undefined, active = false, change = () => {};
	let bound = new Map<string, { from: string; b: Dialogs }>(), targets = new Map<string, Target>(), reach = new Map<string, { from: string; bridgeId: string }>();
	const bridges = new Map<string, Dialogs>(), waiting = new Map<string, (ack?: Ack) => void>(), done = new Map<string, { key: string; at: number; sent: Sent }>(), probes = new Map<string, (e?: Editor) => void>();
	const owner = () => channel?.snapshot().owner?.sessionId === me;
	const sync = () => {
		local.sync();
		if (owner()) try { channel!.publish({ version: 1, type: "sync" }, { audience: "capable", ownerOnly: true }); } catch {} // a broker that dropped meanwhile elects again, which syncs
	};
	const receive = (from: string, msg: ToHub) => {
		if (!active || msg?.version !== 1 || !str(msg.bridgeId)) return;
		const closed = msg.type === "dialogs" && Array.isArray(msg.closed) && msg.closed.length <= 16 && msg.closed.every((c) => str(c?.id) && str(c.by) && opt(c.answerId));
		if (closed && str(msg.pane) && (msg.file === null || str(msg.file)) && Array.isArray(msg.dialogs) && msg.dialogs.every(valid)) (bridges.set(from, msg), change());
		if (msg.type === "ack") waiting.get([from, msg.bridgeId, msg.id, msg.answerId].join("\n"))?.(msg);
		if (msg.type === "probe-result") probes.get([from, msg.bridgeId, msg.probeId].join("\n"))?.(checkProbe({ ...msg }));
	};
	const onEvent = (e: Event) => {
		if (e.type === "owner" && e.owner?.sessionId === me && e.owner.epoch !== epoch && (epoch = e.owner.epoch) && active) sync();
		if (e.type === "message" && e.fromSessionId) receive(e.fromSessionId, e.payload as ToHub);
		if (e.type === "session_left" && e.sessionId && bridges.delete(e.sessionId)) change();
	};
	const merge = (key: string, file: Pending | undefined, ds: Dialog[], readable: boolean): Pending => {
		const d = ds[0]!, adapter = OWNERS.find((o) => o.name === d.owner), base = file ?? { callId: d.toolCallId ?? d.id, tool: adapter?.tool ?? "dialog" }, at = bound.get(key)!;
		const terminal = (why: string): Pending => ({ ...base, why });
		if (file?.tool === "secret_drop") return file; // terminal only, whatever a bridge says
		if (ds.length !== 1) return terminal(SEVERAL);
		if (d.big) return terminal("It is too long to show here; answer it in the terminal.");
		if (!adapter || !readable || (d.toolCallId && (file?.callId !== d.toolCallId || file.tool !== adapter.tool || file.why === SEVERAL))) return terminal(base.why ?? "Answer it in the terminal.");
		if ((d.select ? selectDigest(d.select) : d.questions ? questionsDigest(d.questions) : undefined) !== d.digest) return terminal("The question here differs from the one in the terminal; answer it there.");
		const answer: Answerable = { dialog: d.id, digest: d.digest, ...(d.select ? { select: d.select } : { questions: d.questions }) }, { why: _, ...rest } = base;
		// While an answer is on its way the page shows it read-only, but the bridge still hears that answer resent (Check again: it replays) and any other (busy).
		targets.set(key, { from: at.from, bridgeId: at.b.bridgeId, answer });
		return d.busy ? terminal("An answer is on its way; check the terminal.") : { ...rest, answer };
	};
	const hub: LocalHub & {
		readonly running: boolean; readonly me: string; start(onChange: () => void): void; stop(): void; relayed(sessions: Session[], refs: Map<string, Ref>): Relayed; target(key: string): Target | undefined;
		replay(answerId: string, key: string): Sent | undefined; ended(key: string, dialog: string, answerId: string): Sent | undefined; send(key: string, t: Target, a: Omit<AnswerMessage, "version" | "type" | "to">): Promise<Sent>;
		probe(key: string): Promise<Editor | undefined>;
	} = {
		receive,
		get running() { return active; },
		me,
		/** The channel is registered at the first start, before gui.json names this session; later starts in this process reuse it. */
		start(onChange) {
			[change, active] = [onChange, true];
			try {
				if (!channel && me) pi.events.emit(REGISTER, { namespace: guiNamespace(me), ownerEligible: true, onReady: (c: Channel) => (channel = c), onEvent });
			} catch {
				// No channel: only this session's own dialogs can be answered (in-process), every other one stays read-only.
			}
			epoch = channel?.snapshot().owner?.epoch;
			sync();
		},
		stop() {
			active = false;
			[bridges, bound, targets, reach].forEach((m) => m.clear());
			[...waiting.values(), ...probes.values()].forEach((w) => w());
		},
		/** Binds each relayed list to a unit, from this net reading's sessions and registry. */
		relayed(sessions, refs) {
			[bound, targets, reach] = [new Map(), new Map(), new Map()];
			for (const [from, b] of bridges) {
				const file = sessions.find((s) => s.id === from)?.herdrLocation?.paneId === b.pane ? canonical(b.file ?? undefined) : undefined;
				const ref = file && [...refs.values()].find((r) => r.pane === b.pane && r.file === file);
				if (ref) reach.set(ref.key, { from, bridgeId: b.bridgeId });
				if (ref && (b.dialogs.length || b.closed.length)) bound.set(ref.key, { from, b });
			}
			return { dialogsOf: (key) => bound.get(key)?.b.dialogs, merge };
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
		/** Publishes the answer to its bridge (or calls this session's) and waits up to 5 s for the bridge's ack. */
		async send(key, t, a) {
			const msg: AnswerMessage = { version: 1, type: "answer", to: t.bridgeId, ...a }, k = [t.from, t.bridgeId, a.id, a.answerId].join("\n");
			const ack = new Promise<Ack | undefined>((resolve) => {
				const timer = setTimeout(() => settle(), ACK_MS), settle = (x?: Ack) => (clearTimeout(timer), waiting.delete(k), resolve(x));
				waiting.set(k, settle);
			});
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
		/** What the session's editor would submit, from the bridge bound to its pane and file: undefined with no such bridge or no answer within 1 s. */
		async probe(key) {
			const t = reach.get(key);
			if (!t || !active) return undefined;
			if (t.from === me) return checkProbe({ ...local.probe() });
			const probeId = randomUUID(), k = [t.from, t.bridgeId, probeId].join("\n");
			const got = new Promise<Editor | undefined>((resolve) => {
				const timer = setTimeout(() => settle(), PROBE_MS), settle = (e?: Editor) => (clearTimeout(timer), probes.delete(k), resolve(e));
				probes.set(k, settle);
			});
			try {
				if (!owner()) throw new Error("not the owner");
				channel!.publish({ version: 1, type: "probe", to: t.bridgeId, probeId }, { audience: "capable", ownerOnly: true });
			} catch {
				probes.get(k)?.(); // unreachable: the editor stays unknown
			}
			return got;
		},
	};
	return hub;
}
