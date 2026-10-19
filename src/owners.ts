import { createHash, randomUUID } from "node:crypto";

// Dialog contract v1 (docs/specs/2026-10-18-dialog-answers.md): a package that opens a dialog (its owner) publishes it on pi's event bus
// and takes one answer for it through its own completion path, so the owner decides and nothing reads the screen or sends keys.
// Each adapter maps one owner's events onto the bridge's dialog form and hands it an answer; nothing else in the bridge, the hub, or the
// page knows an owner, so swapping one (another ask_user package, another prefix) means replacing its entry in OWNERS.

export interface Bus { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void }
export interface Choice { label: string; note?: string; localOnly?: true }
export interface Select { title: string; choices: Choice[]; copy?: string }
export interface Option { title: string; description?: string; preview?: true }
export interface Question { question: string; header?: string; multiple: boolean; options: Option[] }
/** An open dialog as the bridge relays it: a `select` (labelled choices) or `questions` (a questionnaire), `big` when too long to relay, `busy` while an answer is on its way. */
export interface Dialog { owner: string; id: string; toolCallId?: string; digest: string; select?: Select; questions?: Question[]; big?: true; busy?: true }
/** What the page may answer, carried on a waiting unit's `pending`. */
export interface Answerable { dialog: string; digest: string; select?: Select; questions?: Question[] }
/** One question's answer: chosen option indexes, own words, a note. */
export interface Reply { choices?: number[]; text?: string; note?: string }
/** An answer for one dialog: `choice` for a select, one `answers` entry per question. `answerId` is the page's idempotency key. */
export interface Answer { id: string; answerId: string; digest: string; choice?: number; answers?: Reply[] }
export interface Verdict { accepted: boolean; reason?: string }
/** `closed` without `by` leaves it to the bridge (remote when its answer was taken, else local). */
export interface Report { open(adapter: OwnerAdapter, d: Dialog): void; closed(id: string, by?: string): void }
export interface OwnerAdapter {
	name: string;
	/** The tool whose call opens the dialog; a dialog naming a toolCallId must belong to a call of this tool in flight. */
	tool?: string;
	/** A gate: its dialog asks about whichever tool's call its `toolCallId` names (pi-code's hook confirmation), so it binds to a call in flight of any tool but must name one. */
	gate?: true;
	listen(bus: Bus, report: Report): () => void;
	/** Hands one answer to the owner; `done` gets the verdict (synchronously when the owner answers inside its listener). Returns the cleanup. */
	answer(bus: Bus, d: Dialog, a: Answer, done: (v: Verdict) => void): () => void;
	/** Closes the dialog when the tool call is aborted, for an owner that ignores the abort signal. */
	cancel?(bus: Bus, d: Dialog): void;
}

const str = (v: unknown): v is string => typeof v === "string";
export const digestOf = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(["pi-dialog/1", ...parts]), "utf8").digest("hex");
/** Notes, `localOnly`, and `copy` are hints and not hashed. */
export const selectDigest = (s: Select) => digestOf(["select", s.title, s.choices.map((c) => c.label)]);
export const questionsDigest = (qs: Question[]) => digestOf(["questions", qs.map((q) => [q.question, q.header ?? null, q.multiple, q.options.map((o) => [o.title, o.description ?? null])])]);

/** A contract-v1 select dialog, or undefined (another version or shape: a relay never guesses at one). */
export function selectOf(owner: string, raw: unknown): Dialog | undefined {
	const p = raw as { version?: unknown; id?: unknown; toolCallId?: unknown; digest?: unknown; select?: { title?: unknown; choices?: unknown; copy?: unknown } };
	const choices = Array.isArray(p?.select?.choices) ? (p.select.choices as Choice[]) : undefined;
	if (p?.version !== 1 || !str(p.id) || p.id.length > 64 || !str(p.digest) || !str(p.select?.title) || !choices?.length || (p.toolCallId !== undefined && !str(p.toolCallId))) return;
	if (!choices.every((c) => str(c?.label) && (c.note === undefined || str(c.note)))) return;
	const select = { title: p.select.title, choices: choices.map((c) => ({ label: c.label, ...(c.note ? { note: c.note } : {}), ...(c.localOnly === true ? { localOnly: true as const } : {}) })), ...(str(p.select.copy) ? { copy: p.select.copy } : {}) };
	return { owner, id: p.id, ...(p.toolCallId ? { toolCallId: p.toolCallId as string } : {}), digest: p.digest, select };
}

/** An owner that speaks contract v1 under `prefix` (pi-robot-hand; pi-mcp-adapter's fork once it emits). */
const contract = (name: string, prefix: string, tool?: string, gate?: true): OwnerAdapter => ({
	name, tool, ...(gate ? { gate } : {}),
	listen(bus, report) {
		const self = this, offs = [
			bus.on(`${prefix}:pending`, (raw) => { const d = selectOf(name, raw); if (d) report.open(self, d); }),
			bus.on(`${prefix}:closed`, (raw) => { const c = raw as { version?: unknown; id?: unknown; by?: unknown }; if (c?.version === 1 && str(c.id)) report.closed(c.id, str(c.by) ? c.by : "error"); }),
		];
		return () => offs.forEach((off) => off());
	},
	answer: (bus, d, a, done) => {
		const off = bus.on(`${prefix}:answer-result`, (raw) => {
			const r = raw as { version?: unknown; id?: unknown; answerId?: unknown; accepted?: unknown; reason?: unknown };
			if (r?.version === 1 && r.id === d.id && r.answerId === a.answerId && typeof r.accepted === "boolean") done({ accepted: r.accepted, ...(str(r.reason) ? { reason: r.reason } : {}) });
		});
		bus.emit(`${prefix}:answer`, { version: 1, id: d.id, answerId: a.answerId, digest: a.digest, selections: [a.choice] });
		return off;
	},
});

// @juicesharp/rpiv-ask-user-question 2.13.9 has its own channel (events.ts): a prompt keyed by toolCallId with the full questions, a strict
// all-or-nothing answer (first answer wins), a verdict per attempt, and `blocked {active: false}` when it ends. It has no dialog id or digest,
// so the adapter mints the id and the bridge's digest check stands in for the owner's. It ignores the tool's abort signal: `cancel` closes it.
const RPIV = "rpiv:ask-user", CODES: Record<string, string> = { not_found: "closed", invalid_payload: "malformed", invalid_answer: "not-allowed", unsupported_host: "not-allowed" };
function questionsOf(raw: unknown): Question[] | undefined {
	if (!Array.isArray(raw) || !raw.length || raw.length > 4) return;
	const qs = raw.map((q): Question | undefined => {
		const options = Array.isArray(q?.options) && q.options.every((o: { label?: unknown; description?: unknown }) => str(o?.label) && (o.description === undefined || str(o.description))) ? (q.options as { label: string; description?: string; hasPreview?: unknown }[]) : undefined;
		return str(q?.question) && (q.header === undefined || str(q.header)) && options ? { question: q.question, ...(q.header ? { header: q.header } : {}), multiple: q.multiSelect === true, options: options.map((o) => ({ title: o.label, ...(o.description ? { description: o.description } : {}), ...(o.hasPreview === true ? { preview: true as const } : {}) })) } : undefined;
	});
	return qs.every(Boolean) ? (qs as Question[]) : undefined;
}
export const rpiv: OwnerAdapter = {
	name: "rpiv", tool: "ask_user_question",
	listen: (bus, report) => {
		const ids = new Map<string, string>(), offs = [
			bus.on(`${RPIV}:prompt`, (raw) => {
				const p = raw as { toolCallId?: unknown; questions?: unknown }, questions = questionsOf(p?.questions);
				if (!str(p?.toolCallId) || !questions || ids.has(p.toolCallId)) return;
				const id = randomUUID();
				ids.set(p.toolCallId, id);
				report.open(rpiv, { owner: rpiv.name, id, toolCallId: p.toolCallId, digest: questionsDigest(questions), questions });
			}),
			bus.on(`${RPIV}:blocked`, (raw) => {
				const b = raw as { active?: unknown; toolCallId?: unknown }, id = b?.active === false && str(b.toolCallId) ? ids.get(b.toolCallId) : undefined;
				if (id) (ids.delete(b.toolCallId as string), report.closed(id));
			}),
		];
		return () => offs.forEach((off) => off());
	},
	answer: (bus, d, a, done) => {
		if (a.digest !== d.digest || !a.answers) return done({ accepted: false, reason: a.answers ? "digest" : "malformed" }), () => {};
		const off = bus.on(`${RPIV}:answer-result`, (raw) => {
			const r = raw as { ok?: unknown; code?: unknown; requestId?: unknown; toolCallId?: unknown };
			if (r?.requestId === a.answerId && r.toolCallId === d.toolCallId) done(r.ok === true ? { accepted: true } : { accepted: false, reason: CODES[String(r.code)] ?? "malformed" });
		});
		bus.emit(`${RPIV}:answer`, { toolCallId: d.toolCallId, requestId: a.answerId, answers: a.answers.map((r, questionIndex) => ({ questionIndex, ...(r.choices?.length ? { optionIndexes: r.choices } : {}), ...(r.text !== undefined ? { text: r.text } : {}), ...(r.note ? { notes: r.note } : {}) })) });
		return off;
	},
	cancel: (bus, d) => bus.emit(`${RPIV}:answer`, { toolCallId: d.toolCallId, requestId: `cancel-${d.id}`, cancel: true }),
};

export const robotHand = contract("robot-hand", "robot-hand", "robot_hand");
/** pi-mcp-adapter's tool approval and project trust (its fork, spec task 4): inert until that package emits. */
export const mcpAdapter = contract("pi-mcp-adapter", "pi-mcp-adapter:dialog");
/** pi-code's hooks extension: its confirmation before a gated tool call (Allow or Deny), whichever tool that is. */
export const piCode = contract("pi-code", "pi-code:dialog", undefined, true);
export const OWNERS: OwnerAdapter[] = [robotHand, rpiv, mcpAdapter, piCode];
