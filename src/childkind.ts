import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENTRY } from "./state.ts";

// A pi-herdr-agents child records its role in its own session file (docs/specs/2026-11-09-agent-kinds.md §8): a resume mints a new id and a launch script that names no role,
// and the session file is the one thing every launch of the child shares. pi writes no file before the first message, so the entry goes in at the first turn_start and
// reaches the file with the task message. Only one is written: a resume keeps the file and its entry, and the net reads the first one (netdata.ts `agentOfSession`).

/** Appends `straw-boss { agent: <PI_SUBAGENT_AGENT> }` at the child's first turn, when the variable is set and the session holds no such entry yet. */
export function registerChildKind(pi: ExtensionAPI, env: NodeJS.ProcessEnv): void {
	const agent = env.PI_SUBAGENT_AGENT;
	if (!agent) return; // a handoff launch, a bare spawn, and a resume name no role
	let done = false;
	pi.on("turn_start", (_event, ctx) => {
		if (done) return;
		done = true;
		const has = ctx.sessionManager.getEntries().some((e) => e.type === "custom" && e.customType === ENTRY && typeof (e.data as { agent?: unknown } | undefined)?.agent === "string");
		if (!has) pi.appendEntry(ENTRY, { agent });
	});
}
