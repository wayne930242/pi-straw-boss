import { join } from "node:path";
import type { IntercomLike } from "./kit.ts";
import type { Session } from "../herdr.ts";
import { isHead, isSub, type HerdrRun, workspaces } from "../herdr.ts";
import { type Incoming } from "./kit.ts";
import { WATCH_BRIEF } from "./autowatch.ts";
import { answerAsk, asked, openAsks } from "./headasks.ts";
import type { Locale } from "../towerprompt/messages.ts";
import { buildHeadBrief, headTools, type HeadWorkspace } from "./headbrief.ts";
import { headGate } from "./headgate.ts";
import { refuseHead } from "./head.ts";
import type { Log } from "./log.ts";
import { fieldsOf, withoutField } from "../header.ts";
import { headId, type Slot } from "./record.ts";
import { ageOf, gatherMains } from "./towerbrief.ts";
import { appendEvent, type ServiceRecord } from "./towerstore.ts";
import { lastNote, type RunRecord } from "./towerrunstore.ts";
import { lapsed, memorySection, readMemory } from "./towermemory.ts";
import type { Seen } from "./towerseen.ts";

// The head tower's two seams into the tower service (docs/specs/2026-11-04-head-tower.md, Who reaches it, Runs): what reaches its identity through intercom (the gate), and the brief of its runs. The service
// (towers.ts) hands over what it knows of its services, and this file holds the head's rules so towers.ts does not.

/** A tower run's state as a brief says it. */
export const stateWord = (state: string | undefined, fallback: string): string => (state ? ({ standing: "standing by", waking: "running", running: "running", closing: "closing", held: "held" } as Record<string, string>)[state] ?? fallback : fallback);

const phrase = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * `relay=boss:…` tells a workspace tower that a message carries the boss's own instruction, so the field is believed from the head identity alone: the text of anyone else loses it before the event is queued (review HH2-F001).
 * The header is the sender's own code's, but a message from a main or a stray pi is only as true as its sender's id.
 */
export function relayOnlyFromHead(slot: Slot, senderId: string, text: string): string {
	if (senderId === headId(slot)) return text;
	if (fieldsOf(text)) return fieldsOf(text)!.relay === undefined ? text : withoutField(text, "relay");
	// Fail closed (review HH3-F001): a header-like start that does not parse (a stray field, a capital, a leading space) loses every `relay=` of its first line, since the tower reads the field by eye.
	if (!/^\s*\[straw net /.test(text)) return text;
	const end = text.indexOf("\n") < 0 ? text.length : text.indexOf("\n");
	return text.slice(0, end).replace(/relay=(?:"[^"]*"|[^\s\]"]*)/g, "") + text.slice(end);
}

export interface HeadIntakeDeps {
	slot: Slot;
	log: Log;
	now(): number;
	/** The workspace this sender is the tower of (a service of this server, else a resident tower that holds a workspace's `tower` token); undefined for anyone else. */
	towerOf(senderId: string): Promise<string | undefined>;
	/** The head's record and its seen-ledger (towerseen.ts); the intake dedupes by sender and message id as every tower does. */
	record(): ServiceRecord;
	seen(): Seen;
	/** A queued event wakes the head's run hub. */
	poke(): void;
}
/**
 * A message that reached the head identity through intercom. Only a tower's answer to an open ask of the head is taken: it is written to the queue with a flush, recorded on the ask, and receipted `queued`; anything else
 * is refused with the sentence and a receipt, and nothing is queued, noted, or woken. No text reaches the log.
 */
export async function headIntake(d: HeadIntakeDeps, client: IntercomLike, from: Session, message: Incoming): Promise<void> {
	const text = message.content.text;
	const sender = await d.towerOf(from.id).catch(() => undefined);
	const verdict = headGate({ text, senderWorkspace: sender, isOpen: (workspace, id) => asked(d.slot, d.now(), workspace, id) });
	if (!verdict.ok) return refuseHead(client, from, message, d.log, d.now);
	try {
		const seen = d.seen(), kept = seen.check(from.id, message.id, text);
		if (kept === "conflict") return d.log.line("tower-dropped", { workspace: d.record().workspace, from: from.id, why: "the same message id with other content" });
		if (kept === "new") {
			const written = appendEvent(d.slot, d.record(), { kind: "intercom", from: { id: from.id, ...(from.name ? { name: from.name } : {}) }, text, at: new Date(d.now()).toISOString(), messageId: message.id });
			seen.add(from.id, message.id, text);
			// The ask records the answer by its first line, without the header the sender's code wrote.
			answerAsk(d.slot, d.now(), { id: verdict.ask, workspace: verdict.workspace, text: text.replace(/^\[straw net [^\]]*\]\s*/, "") });
			d.log.line("tower-event", { workspace: d.record().workspace, kind: "intercom", from: from.id, seq: written.seq, ask: verdict.ask });
			d.poke();
		}
		client.sendMessageReceipt?.({ messageId: message.id, status: "queued", timestamp: d.now() });
	} catch (cause) {
		d.log.line("error", { code: "queue", text: phrase(`an event for ${d.record().id} could not be queued: ${(cause as Error).message}`, 300) });
	}
}

export interface HeadBriefDeps {
	/** The auto mode line while it is on (autotower.ts `briefLine`). */
	auto?: () => string | undefined;
	slot: Slot;
	run: HerdrRun;
	now(): number;
	record(): ServiceRecord;
	/** The live sessions of the broker through the head's connection. */
	sessions(): Promise<Session[]>;
	/** A workspace's tower as the brief says it: `standing by`, `running`, `closing`, `held`, `an older tower`, or `none`. */
	towerState(workspace: string, tokens: Record<string, string> | undefined): string;
	/** sb's locale: the brief names it as the language of a wait for the boss. */
	locale: Locale;
}
/** The brief of a head run: the chapter, the workspaces now (each base's tower and mains), the open asks, the memory, and the last handoff note (headbrief.ts). */
export async function headBrief(d: HeadBriefDeps, input: { woken: number; run: RunRecord }): Promise<{ text: string; digestKeys: string[]; expired?: string[] }> {
	const ws = d.record().workspace, all = await workspaces(d.run), at = new Date(input.woken);
	const rows: HeadWorkspace[] = [];
	for (const w of all.filter((x) => !isSub(x) && !isHead(x)).slice(0, 20)) {
		const { rows: mains } = await gatherMains({ run: d.run, now: d.now, sessions: d.sessions, boardDir: join(d.slot.stateDir, "board"), workspace: w, ledger: [] }).catch(() => ({ rows: [] }));
		rows.push({ label: phrase(w.label, 60), id: w.workspace_id, ...(w.worktree?.checkout_path ? { folder: w.worktree.checkout_path } : {}), tower: d.towerState(w.workspace_id, w.tokens), rows: mains });
	}
	const kept = readMemory(d.slot, ws, d.now()), section = memorySection(kept.memory, d.now(), kept.problem), note = lastNote(d.slot, ws, "local");
	const chapter = input.run.chapter ?? { n: 1, since: input.run.startedAt, turns: 0, resumed: false };
	return {
		digestKeys: [],
		expired: section.expired,
		text: buildHeadBrief({
			identity: d.record().id, woken: `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`, boss: Boolean(input.run.conversation), chapter,
			workspaces: rows, ...(d.auto?.() ? { auto: `${d.auto()!}\n${WATCH_BRIEF}` } : {}),
			asks: openAsks(d.slot, d.now()).map((a) => ({ id: a.id, label: phrase(a.label, 60), age: ageOf(d.now() - a.at), first: a.first, ...(a.answers.at(-1) ? { answer: a.answers.at(-1)!.first } : {}) })),
			memory: section.text, lapsed: kept.memory.entries.filter((e) => e.for === "boss" && lapsed(e, d.now())).map((e) => e.id), ...(note ? { note: { text: note.note, age: ageOf(d.now() - Date.parse(note.at)) } } : {}), tools: headTools(d.locale), flags: [],
		}),
	};
}
