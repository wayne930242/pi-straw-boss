import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dutyOfAgent } from "./duty.ts";

// The hint to `boss_duty standing` (docs/specs/2026-11-21-box-mac-waits.md §5, item D; boss decision D8): a coordinator main whose job has become watching gets one line, once per session, on the result of the call that shows it: dispatching
// a watchdog subagent, or starting `watch` of the sb CLI under `MonitorCreate`. The hint never switches the kind; the kind is the main's or the boss's to set.

export const STANDING_HINT = "Your job looks like a standing watch: `boss_duty standing` makes it your kind (watch through monitors, a question goes to `call_tower why=blocked`).";

/** Whether this call starts a watch: a watchdog subagent, or the CLI's `watch` under a monitor. */
export function startsWatch(toolName: string, input: unknown): boolean {
	const args = (typeof input === "object" && input !== null ? input : {}) as { agent?: unknown; command?: unknown };
	if (toolName === "subagent") return typeof args.agent === "string" && dutyOfAgent(args.agent) === "watchdog";
	return toolName === "MonitorCreate" && typeof args.command === "string" && /(?:cli\.(?:mjs|ts)['"]?|straw-boss)\s+watch\s/.test(args.command);
}

/** `kind`: this session's main kind now (none while it is no main or runs a tower run). */
export function registerStandingHint(pi: ExtensionAPI, kind: () => string | undefined): void {
	let told = false;
	pi.on("session_start", () => void (told = false));
	pi.on("tool_result", (event) => {
		if (told || event.isError || kind() !== "coordinator" || !startsWatch(event.toolName, event.input)) return;
		told = true;
		return { content: [...event.content, { type: "text" as const, text: STANDING_HINT }] };
	});
}
