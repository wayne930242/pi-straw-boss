import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RUN_END_EVENT, runEndOf } from "./run-end.ts";

// sb's simple host (docs/how-it-works.md#the-subagent-host): Maestro registers its whole surface, and this API in front of Pi keeps only what the
// boss chose, under the names and parameters prompts and skills already use: `subagent` (one task, auto-exit, the result as a message), `subagent_cancel`,
// `subagent_resume` and `subagents_list`, and the `/subagent` command. Persistent specialists, interrupts, managed worktrees, accept checks and the
// task-model writer are not registered; a call that still passes one of their parameters is refused with what to do instead.

/** Maestro's tools that the simple host does not register. */
export const DROPPED_TOOLS: readonly string[] = ["subagent_send", "subagent_stop", "subagent_interrupt", "worktree_list", "worktree_remove", "subagents_write_task_models"];
/** Maestro's commands that the simple host does not register. */
export const DROPPED_COMMANDS: readonly string[] = ["worktree", "subagents-init"];
/** The kept tools, and what to do instead of each parameter they no longer take. */
export const DROPPED_PARAMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	subagent: {
		persistent: "a child runs one task and exits: give it the whole task, and continue it later with subagent_resume",
		notify: "a child runs one task and exits, so it has no notices between tasks",
		worktree: "create the worktree yourself (git worktree add) and pass its path as cwd",
		accept: "put the check in the task and verify the result yourself",
	},
};

export const SUBAGENT_DESCRIPTION =
	"Launch a Pi subagent in a Herdr split pane. It runs one task, exits when done, and its result arrives later as a new message. " +
	"Use one child per bounded outcome; continue a finished or cancelled child with subagent_resume. " +
	"Do not poll or guess the result; end the turn or do other independent work.";
export const RESUME_DESCRIPTION =
	"Resume a saved subagent session in a new Herdr split pane: continue a cancelled, failed or finished run, or send follow-up work. " +
	"The call returns at once and the result arrives later as a message. Do not poll for it.";

const REWORDED: Record<string, string> = {
	cwd: "Working directory of the child. Defaults to this session's.",
	model: "Exact authenticated provider/model-id, a comma-separated fallback list, or task:<category> as the whole value. For ordinary review, prefer a different authenticated model family. Omitting uses the role's model, then the configured models.agents entry and models.default, then the parent model.",
};

interface Schema { properties?: Record<string, Record<string, unknown>>; required?: string[] }

/** The schema without the dropped parameters (the model never sees them), the rest as Maestro wrote it. Symbol keys (TypeBox's kind) are kept. */
export function simpleSchema<T extends object>(schema: T, dropped: readonly string[]): T {
	const s = schema as T & Schema;
	const properties = Object.fromEntries(Object.entries(s.properties ?? {}).filter(([k]) => !dropped.includes(k)).map(([k, v]) => [k, REWORDED[k] ? { ...v, description: REWORDED[k] } : v]));
	return { ...s, properties, ...(s.required ? { required: s.required.filter((k) => !dropped.includes(k)) } : {}) };
}

/** The refusal of a call that passes a dropped parameter, or undefined. A `null` or `false` is what "not passed" means for these, and passes. */
export function droppedParamError(tool: string, params: unknown): string | undefined {
	const table = DROPPED_PARAMS[tool];
	if (!table || !params || typeof params !== "object") return undefined;
	const used = Object.keys(table).filter((k) => {
		const v = (params as Record<string, unknown>)[k];
		return v !== undefined && v !== null && v !== false;
	});
	return used.length ? `sb's subagent host runs in simple mode and does not take ${used.map((k) => `\`${k}\``).join(", ")}: ${used.map((k) => table[k]).join("; ")}.` : undefined;
}

export interface SimpleDeps {
	/** Whether a role's own definition makes its child persistent (`persistent: true` in its frontmatter): such a role is refused too. */
	persistentRole(agent: string, params: Record<string, unknown>): boolean;
}

/** The API Maestro registers through: drops the tools and commands above, refuses the dropped parameters before Maestro sees the call, and tells each run's end (run-end.ts). */
export function simpleApi(pi: ExtensionAPI, deps: SimpleDeps): ExtensionAPI {
	let modelCatalog: string | undefined;
	const registerTool = (tool: ToolDefinition) => {
		if (DROPPED_TOOLS.includes(tool.name)) return;
		const dropped = Object.keys(DROPPED_PARAMS[tool.name] ?? {});
		const launch = tool.name === "subagent", list = tool.name === "subagents_list";
		const description = launch ? SUBAGENT_DESCRIPTION : tool.name === "subagent_resume" ? RESUME_DESCRIPTION : list ? `${tool.description} See authenticated models and task-category shortlists here before choosing a model.` : tool.description;
		let promptGuidelines = tool.promptGuidelines;
		if (launch && promptGuidelines?.length) {
			// Maestro's buildSubagentRoutingGuidelines puts the catalog last. session_start re-registers this tool with the scoped catalog.
			modelCatalog = promptGuidelines.at(-1);
			promptGuidelines = promptGuidelines.slice(0, -1).map((rule) => rule.replace("task-category shortlists below", "task-category shortlists in subagents_list"));
			promptGuidelines.push("When choosing a model, call subagents_list for authenticated IDs and task-category shortlists.");
		}
		const execute: ToolDefinition["execute"] = async (id, params, signal, onUpdate, ctx) => {
			const refusal = droppedParamError(tool.name, params);
			if (refusal) throw new Error(refusal);
			const agent = (params as { agent?: unknown }).agent;
			if (tool.name === "subagent" && typeof agent === "string" && agent && deps.persistentRole(agent, params as Record<string, unknown>))
				throw new Error(`sb's subagent host runs in simple mode: role \`${agent}\` is defined as a persistent specialist, which it does not run. Launch it with a bare subagent and the role's instructions in the task, or use another role.`);
			const result = await tool.execute(id, params, signal, onUpdate, ctx);
			if (!list || !modelCatalog || result.isError) return result;
			return { ...result, content: [...result.content, { type: "text", text: modelCatalog }] };
		};
		pi.registerTool({ ...tool, description, promptGuidelines, ...(dropped.length ? { parameters: simpleSchema(tool.parameters, dropped) } : {}), execute } as ToolDefinition);
	};
	const registerCommand: ExtensionAPI["registerCommand"] = (name, options) => {
		if (DROPPED_COMMANDS.includes(name)) return;
		pi.registerCommand(name, options);
	};
	const sendMessage: ExtensionAPI["sendMessage"] = (message, options) => {
		pi.sendMessage(message, options);
		const end = runEndOf(message);
		// After the send: Maestro retries a send that throws, so a listener's throw must not reach it (it would deliver the end twice); the ledger counts a run id once.
		if (end) try { pi.events.emit(RUN_END_EVENT, end); } catch (error) { console.warn(`[pi-straw-boss] ${RUN_END_EVENT} listener failed: ${error instanceof Error ? error.message : String(error)}`); }
	};
	return Object.assign(Object.create(pi) as ExtensionAPI, { registerTool, registerCommand, sendMessage });
}
