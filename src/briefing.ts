import { createRoleContext } from "./rolecontext.ts";
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
	const context = createRoleContext(pi);
	let prompts: Record<string, string> = {}, files: PromptSet | undefined;
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
	// Each run gets the whole role section; role, kind, and graph changes during it steer at the next step.
	let briefed: Briefed | undefined, running = false;
	// `dir` is the folder of the files the prompt points to (the switch of trainswitch.ts may give a copy), `state` the state folder, whose `trains` folder holds an integrator's ledgers, `cli` the command that runs cli.mjs (`train check`).
	const render = (text = "", duty = "") => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => ({ dir: files ? files.dir : cfg.promptDir, state: guiDir, cli: cliCommand(), ...s.info, duty })[key] || "none yet");
	const compose = (parts: string[], duty: string) => render(parts.map((part) => prompts[part]).join("\n\n"), duty);
	const steer = (text: string) => pi.sendMessage({ customType: ENTRY, content: `<straw-boss>\n${text}\n</straw-boss>`, display: true, details: context.details() }, { deliverAs: "steer" });
	return {
		load() {
			files = promptSet({ promptDir: cfg.promptDir, stateDir: guiDir, env: cfg.env, warn: (text) => tell(text, "warning") });
			prompts = Object.fromEntries(PROMPTS.map((name) => [name, files!.read(name)]));
		},
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
			context.begin(Boolean(name));
			[briefed, running] = [now, true];
		},
		settled: () => void (running = false),
	};
}
export type Briefing = ReturnType<typeof createBriefing>;
