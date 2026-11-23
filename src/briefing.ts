import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MainDuty } from "./mainduty.ts";
import { cliCommand } from "./server/version.ts";
import { ENTRY, type Kit } from "./state.ts";
import { type PromptSet, promptSet } from "./trainswitch.ts";

const LABEL_GRACE_MS = 10_000;
const LOCATION_LABELS = ["tab", "workspace"] as const;
const PROMPTS = ["main", "tower", "member", "member-no-main", "train", "integrator", "duty-standing"];

/** What a run was briefed with: the role and a main's kind. A plan's graph is no part of it (docs/specs/2026-11-23-lite-main.md §1): the dispatch rules are main.md's, for every kind. */
interface Briefed { name: string | undefined; duty: string }
/** A steer's `details`: what it tells, and what it was written against (`null`: it replaces the whole role prompt, whatever the model held; every steer since 0.83.0 is one); it signs the role prompt it carries (`sig`). */
interface Told { briefed: Briefed; base: Briefed | null; provisional?: true; sig?: string }
const same = (a: Briefed, b: Briefed) => a.name === b.name && a.duty === b.duty;
const sign = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The role prompt: a system prompt section, set when a run starts, and a steer when the role or the kind changes during the session. */
export function createBriefing({ pi, cfg, s, role, guiDir, tell }: Kit, mainDuty: MainDuty) {
	let prompts: Record<string, string> = {}, files: PromptSet | undefined;
	/** The files of a role's prompt, in order: a main's is `main.md`, then its kind's addendum. */
	const partsOf = (name: string, duty: string): string[] => (name !== "main" ? [name] : ["main", ...(duty === "integrator" ? ["integrator"] : duty === "standing" ? ["duty-standing"] : [])]);
	const stateOf = (): Briefed => {
		const current = role();
		return { name: current === "member" && !s.mainId ? "member-no-main" : current, duty: current === "main" ? mainDuty.now() : "" };
	};
	// A rewritten section invalidates the system prompt cache (0.81.0: 53 full rewrites, about 8.9M cache-write tokens in 48 h). Once the role's location labels are ready, the rendered bytes are pinned
	// for the rest of the session, a boss_duty change included (docs/specs/2026-11-23-lite-main.md §2). Role and kind changes, including ones on a different branch, reach the agent as messages.
	// `told` is what the agent holds: the section, then each steer pi delivered (its `message_end`), never one only sent, since pi's queue can drop it first (Esc, the dequeue key, the sb GUI's Edit).
	// One steer waits in the queue at a time (`flight`), and a change meanwhile is written once it arrived, against what it told. A steer an abort left queued arrives at the next run's start, after that run's
	// own was written against the older state: `told` is unknown (`undefined`) then, and the next steer is the whole prompt.
	let idle = () => false, told: Briefed | undefined, flight: Told | undefined, running = false;
	let section: { base: Briefed; text: string } | undefined, labels: typeof s.info | undefined, labelDeadline: number | undefined;
	// Keep the first role's labels for custom templates too. A steer before pinning uses the same fields, read live.
	const labelsOf = () => ({ tab: s.info.tab, workspace: s.info.workspace, head: s.info.head });
	// Empty labels are valid for unnamed tabs. The optional {{head}} is not a gate, and stock train prompts have no location slots.
	const labelled = (name: string, duty: string) => LOCATION_LABELS.every((key) => s.info[key] !== undefined || !partsOf(name, duty).some((part) => prompts[part]?.includes(`{{${key}}}`)));
	const readyToPin = (name: string, duty: string) => {
		if (labelled(name, duty)) return true;
		// Give the asynchronous Herdr look time, but never keep a known role unpinned forever if it fails.
		const now = cfg.now();
		return now >= (labelDeadline ??= now + LABEL_GRACE_MS);
	};
	const compose = ({ name, duty }: Briefed, parts = name ? partsOf(name, duty) : []) => parts.map((part) => prompts[part]).join("\n\n").replace(/\{\{(\w+)\}\}/g, (_, key: string) => ({ dir: files ? files.dir : cfg.promptDir, state: guiDir, cli: cliCommand(), ...(labels ?? labelsOf()), duty } as Record<string, string | undefined>)[key] || "none yet");
	// A compaction that retries no turn gets the message stored, not steered: a steer queued then would make pi continue a run that had ended (runmode.ts does the same with a run's brief).
	let quiet = false;
	// A stored message is in the transcript at the turn's end, and pi reports it to no extension: it is told as it is sent. So is a steer sent while pi is idle (awaiting `agent_settled` handlers, or after a run
	// that failed to start past `before_agent_start`): pi stores it at once (`_appendCustomMessage`), with no `message_end`.
	const steer = (text: string, base: Briefed | null, briefed: Briefed, sig?: string) => {
		const details: Told = { briefed, base, ...(!section && briefed.name && !labelled(briefed.name, briefed.duty) ? { provisional: true } : {}), ...(sig ? { sig } : {}) };
		pi.sendMessage({ customType: ENTRY, content: `<straw-boss>\n${text}\n</straw-boss>`, display: true, details }, quiet ? { triggerTurn: false } : { deliverAs: "steer" });
		if (quiet || idle()) told = briefed;
		else flight = details;
	};
	/** The role prompt a whole steer carries for `now`. */
	const wholeText = (now: Briefed) => compose(now) || "No Straw Boss role applies.";
	/** Steers what changed from `was` to `now`, if anything: a role or a kind gets its whole prompt, which replaces the section's, as does an unknown `was`. */
	const steerChange = (was: Briefed | undefined, now: Briefed) => {
		if ((was && same(was, now)) || (!now.name && !section?.base.name && !was?.name)) return;
		const text = wholeText(now), lead = !was ? "Some of your Straw Boss role updates may be missing or out of order." : now.name !== was.name ? "Your Straw Boss role changed." : `Your kind is now ${now.duty}.`;
		steer(`${lead} Follow only these Straw Boss role instructions, replacing the system section and any earlier role updates:\n\n${text}`, null, now, sign(text));
	};
	/** Tells a running agent what changed since what it holds, unless a steer still waits in pi's queue. */
	const rebrief = () => void (running && !flight && steerChange(told, stateOf()));
	return {
		/** `isIdle` is pi's idle signal (`ctx.isIdle`) of the session that started. */
		load(isIdle: () => boolean = () => false) {
			idle = isIdle;
			files = promptSet({ promptDir: cfg.promptDir, stateDir: guiDir, env: cfg.env, warn: (text) => tell(text, "warning") });
			prompts = Object.fromEntries(PROMPTS.map((name) => [name, files!.read(name)]));
			[section, labels, labelDeadline, told, flight, running] = [undefined, undefined, undefined, undefined, undefined, false];
		},
		/** Whether the loaded prompts have integration off; before they are loaded, the switch is read as `promptSet` will read it. */
		off: () => files?.off,
		/** The folder of the files the prompts point to. */
		dir: () => (files ? files.dir : cfg.promptDir),
		rebrief,
		/** pi delivered a message. A steer of this briefing moves what the agent holds to what it tells, when it was written against what the agent held, or tells what it holds already; else what it holds is unknown. */
		delivered(message: { role?: string; customType?: string; details?: unknown }) {
			const d = message.details as Told | undefined;
			if (message.role !== "custom" || message.customType !== ENTRY || !d?.briefed) return;
			const fits = !(section && d.provisional) && (d.base === null || (told !== undefined && (same(d.base, told) || same(d.briefed, told))));
			[told, flight] = [fits ? d.briefed : undefined, flight === d ? undefined : flight];
			rebrief();
		},
		/** Earlier steers may be gone or stale on this branch. Send the full current guidance, even when it matches the section. */
		fresh(retries = true) {
			[told, flight, quiet] = [undefined, undefined, !retries];
			rebrief();
			quiet = false;
		},
		begin(sections: Record<string, string>, branch: () => readonly SessionEntry[]) {
			const now = stateOf();
			if (now.name && !section && readyToPin(now.name, now.duty)) {
				labels ??= labelsOf();
				// A whole steer with the text this one would carry supersedes everything before it, while the model sees it: pi's context drops what precedes the last compaction's first kept
				// entry (`buildContextEntries`), and a summary may keep older role text. A delta (0.82.x and earlier: a graph's) may have lost its base; a provisional steer may lack labels; an unsigned one (0.81.1 and earlier) may hold older prompts.
				const path = branch(), at = path.findLastIndex((e) => e.type === "custom_message" && e.customType === ENTRY && (e.details as Partial<Told> | undefined)?.briefed);
				const cut = path.findLastIndex((e) => e.type === "compaction"), compaction = path[cut], prior = path[at]?.type === "custom_message" ? path[at].details as Told : undefined;
				const seen = compaction?.type !== "compaction" || path.some((e, i) => i <= at && i < cut && e.id === compaction.firstKeptEntryId) || at > cut;
				if (flight) told = undefined;
				else if (prior) told = seen && prior.base === null && !prior.provisional && same(prior.briefed, now) && prior.sig === sign(wholeText(now)) ? now : undefined;
				else told = told === undefined ? now : undefined;
				section = { base: now, text: compose(now) };
			}
			if (section) sections[ENTRY] = section.text;
			else delete sections[ENTRY];
			// An undelivered steer was dropped or waits for this run's start: if it arrives, `delivered` weighs it against what the agent holds.
			[running, flight] = [true, undefined];
			rebrief();
		},
		settled: () => void (running = false),
	};
}
export type Briefing = ReturnType<typeof createBriefing>;
