import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Todo, todosOf } from "./items.ts";
import { todosOfBranch } from "./todo.ts";

// The planning rule at the moment it is missed (docs/specs/2026-11-26-plan-graph-jit.md; boss 2026-11-26 「sb 在派工當下送規則」): a coordinator or standing main whose `todo` create leaves it with open
// todos and none names a graph gets planning.md §1 and §2 on that result, condensed from the file itself, so the wording has one source. Once, and once more only after its open todos named a graph
// (or it had none open) and then again named none. main.md keeps only its pointer; nothing here reaches a member, a worker, a train, or a tower.

/** The block's last line: what the main does with it. */
export const PLAN_HINT_END = "Set the `graph` field on these todos.";
const OPENING = "sb: your open todos name no graph. From planning.md:";
/** The text of planning.md §1 and §2 the block leaves out, to stay near 1.2 KB: what the page shows, the capacity details (capacity notices carry them), and deferring. Each must be there: a cut that no longer matches is a file error. */
const DROPPED = ["The page shows it beside your kind. ", ", on an unattended device within its capacity budget", " (default 1; 0.25 for a light, API-bound worker)", /^- Defer: .*\n?/m, /\*\*/g];

/** One `## <n>.` section of planning.md, without its heading; a missing one is a file error. */
function section(text: string, n: number): string {
	const found = new RegExp(`^## ${n}\\. ([^\\n]+)\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(text);
	if (!found) throw new Error(`planning.md has no section ${n}`);
	return `${found[1]}: ${found[2].trim()}`;
}

/** The block from planning.md's text: §1 and §2, condensed, then its end line. */
export function planHint(planning: string): string {
	let body = [1, 2].map((n) => section(planning, n)).join("\n");
	for (const cut of DROPPED) {
		const next = body.replace(cut, "");
		if (next === body) throw new Error(`planning.md §1-§2 no longer hold ${String(cut)}`);
		body = next;
	}
	body = body.replace(/\n{2,}/g, "\n").trim();
	return `${OPENING}\n${body}\n${PLAN_HINT_END}`;
}

/** Whether a `todo` call creates a todo: a single create or a batch. */
const creates = (input: unknown) => typeof input === "object" && input !== null && (input as { action?: unknown }).action === "create";
/** The open todos of a plan: not completed, and not a train's step. */
const openOf = (list: readonly Todo[]) => list.filter((t) => t.status !== "completed" && !t.sb);

/** `kind`: this session's main kind now (none while it is no main or runs a tower run); `planning`: the folder of planning.md (its §1-§2 hold no integration blocks), or its text for a test, read at the moment the block is sent. */
export function registerPlanHint(pi: ExtensionAPI, kind: () => string | undefined, planning: string | (() => string)): void {
	let armed = true; // false after the block was shown, until the open todos name a graph or none is open
	pi.on("session_start", () => void (armed = true));
	pi.on("tool_result", (event, ctx) => {
		const k = kind();
		if (event.toolName !== "todo" || event.isError || (k !== "coordinator" && k !== "standing")) return;
		const list = todosOf(event.details) ?? (ctx ? todosOfBranch(ctx.sessionManager.getBranch()) : undefined);
		if (!list) return;
		const open = openOf(list), missing = open.length > 0 && !open.some((t) => t.graph);
		if (!missing) return void (armed = true);
		if (!armed || !creates(event.input)) return;
		const text = planHint(typeof planning === "string" ? readFileSync(join(planning, "planning.md"), "utf8") : planning()); // a planning.md without its sections throws: pi passes the result through and reports the hook's error; tests/plan-hint.test.ts holds the file to them
		armed = false;
		return { content: [...event.content, { type: "text" as const, text }] };
	});
}
