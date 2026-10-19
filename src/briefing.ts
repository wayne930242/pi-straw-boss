import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENTRY, type Kit, type Role } from "./state.ts";

const PROMPTS = ["main", "tower", "member", "member-no-main"];

/** The role prompt: a system prompt section, set when a run starts, and a steer when the role changes during one. */
export function createBriefing({ pi, cfg, s, role }: Kit) {
	let prompts: Record<string, string> = {};
	const promptOf = (current = role()) => (current === "member" && !s.mainId ? "member-no-main" : current);
	// The role's prompt is a system prompt section, set when a run starts. A role that changes during a run (a member promoted as it
	// dispatches a subagent, mains demoted as their tower quits) reaches the agent at its next step as a steer; an idle session gets it with its next run.
	let briefed: Role | undefined, running = false;
	const render = (text = "") => text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => ({ dir: cfg.promptDir, ...s.info })[key] || "none yet");
	return {
		load: () => void (prompts = Object.fromEntries(PROMPTS.map((name) => [name, readFileSync(join(cfg.promptDir, `${name}.md`), "utf8").trim()]))),
		rebrief() {
			const current = role(), name = promptOf(current);
			if (!running || current === briefed || !name) return;
			briefed = current;
			pi.sendMessage({ customType: ENTRY, content: `<straw-boss>\nYour Straw Boss role changed during this run. This replaces the role instructions in your system prompt:\n\n${render(prompts[name])}\n</straw-boss>`, display: true }, { deliverAs: "steer" });
		},
		/** A run starts: the role's prompt becomes the session's section. */
		begin(sections: Record<string, string>) {
			const current = role(), name = promptOf(current);
			if (name) sections[ENTRY] = render(prompts[name]);
			else delete sections[ENTRY];
			[briefed, running] = [current, true];
		},
		settled: () => void (running = false),
	};
}
export type Briefing = ReturnType<typeof createBriefing>;
