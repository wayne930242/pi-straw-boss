import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Graph } from "./duty.ts";
import type { MainDuty } from "./mainduty.ts";
import { cliCommand } from "./server/version.ts";
import { ENTRY, type Kit } from "./state.ts";
import { type PromptSet, promptSet } from "./trainswitch.ts";

const LABEL_GRACE_MS = 10_000;
const LOCATION_LABELS = ["tab", "workspace"] as const;
const PROMPTS = ["main", "tower", "member", "member-no-main", "train", "integrator", "dispatch", "duty-standing", "graph-fan-out", "graph-orchestrator-worker"];
/** The addendum a graph adds to the dispatch rules: `single-loop` adds none (docs/specs/2026-11-09-agent-kinds.md §2a). */
const GRAPH_ADDENDUM: Partial<Record<Graph, string>> = { "fan-out/fan-in": "graph-fan-out", "orchestrator-worker": "graph-orchestrator-worker" };

/** What a run was briefed with: the role, a main's kind, and the graph a coordinator's plan named (an integrator and a standing main carry `dispatch.md` whatever their plan says, so they have none here). */
interface Briefed { name: string | undefined; duty: string; graph: Graph | "" }
/** A steer's `details`: what it tells, and what it was written against (`null`: it replaces the whole role prompt, whatever the model held). */
interface Told { briefed: Briefed; base: Briefed | null; provisional?: true }
const same = (a: Briefed, b: Briefed) => a.name === b.name && a.duty === b.duty && a.graph === b.graph;

/** The role prompt: a system prompt section, set when a run starts, and a steer when the role, the kind, or a coordinator's plan changes during one. */
export function createBriefing({ pi, cfg, s, role, guiDir, tell }: Kit, mainDuty: MainDuty) {
	let prompts: Record<string, string> = {}, files: PromptSet | undefined;
	/** The files of a role's prompt, in order: a main's is `main.md`, then its kind's addendum, then the dispatch rules and the graph's addendum (§2a). */
	const partsOf = (name: string, duty: string, graph: Graph | ""): string[] => {
		if (name !== "main") return [name];
		const kind = duty === "integrator" ? ["integrator"] : duty === "standing" ? ["duty-standing"] : [];
		const dispatch = duty === "coordinator" ? (graph ? ["dispatch", ...(GRAPH_ADDENDUM[graph] ? [GRAPH_ADDENDUM[graph]!] : [])] : []) : ["dispatch"];
		return ["main", ...kind, ...dispatch];
	};
	const stateOf = (): Briefed => {
		const current = role(), duty = current === "main" ? mainDuty.now() : "";
		return { name: current === "member" && !s.mainId ? "member-no-main" : current, duty, graph: duty === "coordinator" ? (mainDuty.graph() ?? "") : "" };
	};
	// A rewritten section invalidates the system prompt cache. Once the role's location labels are ready, pin the rendered bytes, except for an explicit boss_duty change.
	// The section never contains a coordinator's graph. Role and graph changes, including ones on a different branch, reach the agent as messages.
	// `told` is what the agent holds: the section, then each steer pi delivered (its `message_end`), never one only sent, since pi's queue can drop it first (Esc, the dequeue key, the sb GUI's Edit).
	// One steer waits in the queue at a time (`flight`), and a change meanwhile is written once it arrived, against what it told. A steer an abort left queued arrives at the next run's start, after that run's
	// own was written against the older state: `told` is unknown (`undefined`) then, and the next steer is the whole prompt.
	let idle = () => false, told: Briefed | undefined, flight: Told | undefined, running = false, rewriteKind = false;
	let section: { base: Briefed; text: string } | undefined, labels: typeof s.info | undefined, labelDeadline: number | undefined;
	// Keep the first role's labels for custom templates too. A steer before pinning uses the same fields, read live.
	const labelsOf = () => ({ tab: s.info.tab, workspace: s.info.workspace, head: s.info.head });
	const readyToPin = (name: string, duty: string) => {
		// Empty labels are valid for unnamed tabs. The optional {{head}} is not a gate, and stock train prompts have no location slots.
		if (LOCATION_LABELS.every((key) => s.info[key] !== undefined || !partsOf(name, duty, "").some((part) => prompts[part]?.includes(`{{${key}}}`)))) return true;
		// Give the asynchronous Herdr look time, but never keep a known role unpinned forever if it fails.
		const now = cfg.now();
		return now >= (labelDeadline ??= now + LABEL_GRACE_MS);
	};
	const compose = ({ name, duty, graph }: Briefed, parts = name ? partsOf(name, duty, graph) : []) => parts.map((part) => prompts[part]).join("\n\n").replace(/\{\{(\w+)\}\}/g, (_, key: string) => ({ dir: files ? files.dir : cfg.promptDir, state: guiDir, cli: cliCommand(), ...(labels ?? labelsOf()), duty } as Record<string, string | undefined>)[key] || "none yet");
	// A compaction that retries no turn gets the message stored, not steered: a steer queued then would make pi continue a run that had ended (runmode.ts does the same with a run's brief).
	let quiet = false;
	// A stored message is in the transcript at the turn's end, and pi reports it to no extension: it is told as it is sent. So is a steer sent while pi is idle (awaiting `agent_settled` handlers, or after a run
	// that failed to start past `before_agent_start`): pi stores it at once (`_appendCustomMessage`), with no `message_end`.
	const steer = (text: string, base: Briefed | null, briefed: Briefed) => {
		const details: Told = { briefed, base, ...(!section ? { provisional: true } : {}) };
		pi.sendMessage({ customType: ENTRY, content: `<straw-boss>\n${text}\n</straw-boss>`, display: true, details }, quiet ? { triggerTurn: false } : { deliverAs: "steer" });
		if (quiet || idle()) told = briefed;
		else flight = details;
	};
	/** Steers what changed from `was` to `now`, if anything: a role or a kind gets its whole prompt, which replaces the section's, as does an unknown `was`; a coordinator's graph only what it adds, replaces, or drops (§2a). */
	const steerChange = (was: Briefed | undefined, now: Briefed) => {
		if ((was && same(was, now)) || (!now.name && !section?.base.name && !was?.name)) return;
		const whole = (lead: string) => steer(`${lead} Follow only these Straw Boss role instructions, replacing the system section and any earlier role updates:\n\n${compose(now) || "No Straw Boss role applies."}`, null, now);
		if (!was) return whole("Some of your Straw Boss role updates may be missing or out of order.");
		if (now.name !== was.name) return whole("Your Straw Boss role changed.");
		if (now.duty !== was.duty) return whole(`Your kind is now ${now.duty}.`);
		const addendum = now.graph ? GRAPH_ADDENDUM[now.graph] : undefined, graph = (text: string) => steer(text, was, now);
		if (!now.graph) return graph(`Your plan has no open graph: drop your "## Dispatch" and "## Graph:" sections.`);
		if (!was.graph) return graph(`Your plan's graph is now ${now.graph}. Add to your instructions:\n\n${compose(now, ["dispatch", ...(addendum ? [addendum] : [])])}`);
		if (!addendum) return graph(`Your plan's graph is now ${now.graph}. Drop your "## Graph:" section.`);
		graph(`Your plan's graph is now ${now.graph}. ${GRAPH_ADDENDUM[was.graph] ? 'Replace your "## Graph:" section with' : "Add to your instructions"}:\n\n${compose(now, [addendum])}`);
	};
	/** Tells a running agent what changed since what it holds, unless a steer still waits in pi's queue. */
	const rebrief = () => void (running && !flight && steerChange(told, stateOf()));
	return {
		/** `isIdle` is pi's idle signal (`ctx.isIdle`) of the session that started. */
		load(isIdle: () => boolean = () => false) {
			idle = isIdle;
			files = promptSet({ promptDir: cfg.promptDir, stateDir: guiDir, env: cfg.env, warn: (text) => tell(text, "warning") });
			prompts = Object.fromEntries(PROMPTS.map((name) => [name, files!.read(name)]));
			[section, labels, labelDeadline, told, flight, running, rewriteKind] = [undefined, undefined, undefined, undefined, undefined, false, false];
		},
		/** Whether the loaded prompts have integration off; before they are loaded, the switch is read as `promptSet` will read it. */
		off: () => files?.off,
		/** The folder of the files the prompts point to. */
		dir: () => (files ? files.dir : cfg.promptDir),
		rebrief,
		kindDeclared() { rewriteKind = true; },
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
			if (now.name && (section ? rewriteKind && now.name === "main" && section.base.duty !== now.duty : readyToPin(now.name, now.duty))) {
				labels ??= labelsOf();
				const base: Briefed = { ...now, graph: "" };
				if (!section) {
					// A matching whole steer supersedes everything before it. A delta may have lost its base to compaction; a provisional steer may carry missing labels.
					const last = branch().findLast((e) => e.type === "custom_message" && e.customType === ENTRY && (e.details as Partial<Told> | undefined)?.briefed);
					const prior = last?.type === "custom_message" ? last.details as Told : undefined;
					if (flight) told = undefined;
					else if (prior) told = prior.base === null && !prior.provisional && same(prior.briefed, now) ? prior.briefed : undefined;
					else told = told === undefined ? base : undefined;
				} else if (told === section.base && !flight) told = base;
				section = { base, text: compose(base) };
			}
			if (section) sections[ENTRY] = section.text;
			else delete sections[ENTRY];
			// An undelivered steer was dropped or waits for this run's start: if it arrives, `delivered` weighs it against what the agent holds.
			[running, flight, rewriteKind] = [true, undefined, false];
			rebrief();
		},
		settled: () => void (running = false),
	};
}
export type Briefing = ReturnType<typeof createBriefing>;
