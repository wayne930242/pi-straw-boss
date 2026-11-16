import type { Graph } from "./duty.ts";
import type { MainDuty } from "./mainduty.ts";
import { cliCommand } from "./server/version.ts";
import { ENTRY, type Kit, type Role } from "./state.ts";
import { type PromptSet, promptSet } from "./trainswitch.ts";

const PROMPTS = ["main", "tower", "member", "member-no-main", "train", "integrator", "dispatch", "duty-standing", "graph-fan-out", "graph-orchestrator-worker"];
/** The addendum a graph adds to the dispatch rules: `single-loop` adds none (docs/specs/2026-11-09-agent-kinds.md §2a). */
const GRAPH_ADDENDUM: Partial<Record<Graph, string>> = { "fan-out/fan-in": "graph-fan-out", "orchestrator-worker": "graph-orchestrator-worker" };

/** What a run was briefed with: the role, a main's kind, and the graph a coordinator's plan named (an integrator and a standing main carry `dispatch.md` whatever their plan says, so they have none here). */
interface Briefed { role: Role | undefined; duty: string; graph: Graph | "" }

/** The role prompt: a system prompt section, set when a run starts, and a steer when the role, the kind, or a coordinator's plan changes during one. */
export function createBriefing({ pi, cfg, s, role, guiDir, tell }: Kit, mainDuty: MainDuty) {
	let prompts: Record<string, string> = {}, files: PromptSet | undefined;
	// A train has a prompt of its own (docs/specs/2026-11-07-train-workers.md §13.1): the main's would tell it to plan, dispatch and ask the boss.
	const nameOf = (current = role()) => (current === "member" && !s.mainId ? "member-no-main" : current);
	/** The files of a role's prompt, in order: a main's is `main.md`, then its kind's addendum, then the dispatch rules and the graph's addendum (§2a). */
	const partsOf = (name: string, duty: string, graph: Graph | ""): string[] => {
		if (name !== "main") return [name];
		const kind = duty === "integrator" ? ["integrator"] : duty === "standing" ? ["duty-standing"] : [];
		const dispatch = duty === "coordinator" ? (graph ? ["dispatch", ...(GRAPH_ADDENDUM[graph] ? [GRAPH_ADDENDUM[graph]!] : [])] : []) : ["dispatch"];
		return ["main", ...kind, ...dispatch];
	};
	const stateOf = (): Briefed => {
		const duty = role() === "main" ? mainDuty.now() : "";
		return { role: role(), duty, graph: duty === "coordinator" ? (mainDuty.graph() ?? "") : "" };
	};
	// The role's prompt is a system prompt section, set when a run starts. A role that changes during a run (a member promoted as it
	// dispatches a subagent, mains demoted as their tower quits), a kind that switches, or a plan that names a graph reaches the agent at its next step as a steer; an idle session gets it with its next run.
	let briefed: Briefed | undefined, running = false;
	// `dir` is the folder of the files the prompt points to (the switch of trainswitch.ts may give a copy), `state` the state folder, whose `trains` folder holds an integrator's ledgers, `cli` the command that runs cli.mjs (`train check`). What a prompt may name is this session's own (its tab's label, its workspace's label, its kind) or fixed for the process, never another session's name or state: the tower's or the main's name in the section rewrote it whenever that session left, came back, or renamed itself, and a rewritten section is read with the whole context uncached; `boss_status` has the live values (docs/how-it-works.md, The role section stays put).
	const render = (text = "", duty = "") => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => ({ dir: files ? files.dir : cfg.promptDir, state: guiDir, cli: cliCommand(), tab: s.info.tab, workspace: s.info.workspace, head: s.info.head, duty } as Record<string, string | undefined>)[key] || "none yet");
	const compose = (parts: string[], duty: string) => render(parts.map((part) => prompts[part]).join("\n\n"), duty);
	const steer = (text: string) => pi.sendMessage({ customType: ENTRY, content: `<straw-boss>\n${text}\n</straw-boss>`, display: true }, { deliverAs: "steer" });
	return {
		load() {
			files = promptSet({ promptDir: cfg.promptDir, stateDir: guiDir, env: cfg.env, warn: (text) => tell(text, "warning") });
			prompts = Object.fromEntries(PROMPTS.map((name) => [name, files!.read(name)]));
		},
		/** Whether the loaded prompts have integration off; before they are loaded, the switch is read as `promptSet` will read it. */
		off: () => files?.off,
		/** The folder of the files the prompts point to. */
		dir: () => (files ? files.dir : cfg.promptDir),
		rebrief() {
			const now = stateOf(), name = nameOf(now.role);
			if (!running || !briefed || !name) return;
			const was = briefed;
			if (now.role === was.role && now.duty === was.duty && now.graph === was.graph) return;
			briefed = now;
			if (now.role !== was.role) return steer(`Your Straw Boss role changed during this run. This replaces the role instructions in your system prompt:\n\n${compose(partsOf(name, now.duty, now.graph), now.duty)}`);
			if (now.duty !== was.duty) return steer(`Your kind is now ${now.duty}. This replaces the role instructions in your system prompt:\n\n${compose(partsOf(name, now.duty, now.graph), now.duty)}`);
			// Only a coordinator's graph differs (§2a): the steer carries what changed, not the prompt.
			const addendum = now.graph ? GRAPH_ADDENDUM[now.graph] : undefined;
			if (!now.graph) return steer(`Your plan has no open graph: drop your "## Dispatch" and "## Graph:" sections.`);
			if (!was.graph) return steer(`Your plan's graph is now ${now.graph}. Add to your instructions:\n\n${compose(["dispatch", ...(addendum ? [addendum] : [])], now.duty)}`);
			if (!addendum) return steer(`Your plan's graph is now ${now.graph}. Drop your "## Graph:" section.`);
			steer(`Your plan's graph is now ${now.graph}. ${GRAPH_ADDENDUM[was.graph] ? 'Replace your "## Graph:" section with' : "Add to your instructions"}:\n\n${compose([addendum], now.duty)}`);
		},
		/** A run starts: the role's prompt becomes the session's section. */
		begin(sections: Record<string, string>) {
			const now = stateOf(), name = nameOf(now.role);
			if (name) sections[ENTRY] = compose(partsOf(name, now.duty, now.graph), now.duty);
			else delete sections[ENTRY];
			[briefed, running] = [now, true];
		},
		settled: () => void (running = false),
	};
}
export type Briefing = ReturnType<typeof createBriefing>;
