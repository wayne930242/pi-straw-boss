import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerChildKind } from "./childkind.ts";
import { callServer } from "./hygiene.ts";
import type { Reply } from "./server/socket.ts";
import { ENTRY } from "./state.ts";

// The watchdog's side in a pi-herdr-agents child (docs/specs/2026-11-09-agent-kinds.md §10, D3). Registered in every child, in Herdr or not (a Core-launched child has no pane), and inert in
// every child that is not a watchdog: the two tools are inactive unless `--tools` names them, and every handler returns first. A watchdog reads one net unit through the sb server
// (`watch_read`, a long poll) and tells only its dispatcher (`watch_report`); sb holds that here, whatever tool list a spawn or a resume passed.

/** What a watchdog may call: its role's three tools and the two pi-herdr-agents gives every child. */
export const WATCHDOG_TOOLS: readonly string[] = ["read", "watch_read", "watch_report", "caller_ping", "subagent_done"];
export const WATCHDOG_BLOCK = "sb: a watchdog only reads and reports";
export const WAIT_MS = 600_000, WAIT_MAX_MS = 3_000_000, REQUEST_MS = 55_000, RETRY_MS = 2_000, REPORT_MS = 10_000;
/** What a watchdog that cannot watch runs under, if pi starts its run anyway: one short turn whose tools are all blocked. */
export const EMPTY_REPLY = "Reply with nothing: no text and no tool call. This session cannot start.";
const ABORTED = "Operation aborted";

export interface WatchdogDeps {
	/** One request to the live sb server; undefined when none runs or it does not answer in `timeoutMs`. */
	call?: (request: Record<string, unknown>, timeoutMs: number) => Promise<Reply | undefined>;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

/** Whether a child is a watchdog: its first launch names the role, or its session's first `straw-boss { agent }` entry does (a resume names none). A tool list is never a sign (AK4-F006.k). */
export function isWatchdog(envAgent: string | undefined, entries: readonly { type?: string; customType?: string; data?: unknown }[]): boolean {
	if (envAgent === "watchdog") return true;
	const first = entries.find((e) => e.type === "custom" && e.customType === ENTRY && typeof (e.data as { agent?: unknown } | undefined)?.agent === "string");
	return (first?.data as { agent?: string } | undefined)?.agent === "watchdog";
}

const READ_DESCRIPTION = "Wait for one unit of the straw net to change. Pass `since` from the last reply; the call returns when the unit's state changes or after `waitMs`. Reply: `{ state, since, now, unit?, successor?, server? }`. `state`: `changed` (the unit's mark, a monitor's status or exit, todo progress, a train's step, or its subagents' marks moved), `stalled` (no tick and no monitor line for `quietMs`; once until it moves again), `load` (a monitor's load crossed `loadMax`; once per crossing), `unchanged` (nothing by `waitMs`, or a message for you arrived: read it, then call again), `expired` (`deadline` passed), `gone` (the unit ended; `successor` is the key that took over, if any). `now` is the time in ms. `unit`: `mark`, `note`, `todo`, `monitors` (`status`, `exit`, `last`, `load`, `ageMs`), `train` (`status`, `step`, `waits`), `subs`. `server: unreachable|outdated` means the sb server did not answer or is too old: call again.";
const REPORT_DESCRIPTION = "Send one finding to the agent that dispatched you; it is the only one you can reach. Reply: `delivered`, `queued`, or `gone` (your dispatcher ended). At most one report every 30 s, and never the same text twice.";

export function registerWatchdog(pi: ExtensionAPI, env: NodeJS.ProcessEnv, deps: WatchdogDeps = {}): void {
	const call = deps.call ?? ((request, timeoutMs) => callServer(env, request, timeoutMs)), now = deps.now ?? Date.now, sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const name = env.PI_SUBAGENT_NAME?.trim() || env.PI_SUBAGENT_ID || "";
	const report = (text: string) => call({ cmd: "watch-report", session: env.PI_SUBAGENT_SESSION, child: env.PI_SUBAGENT_ID, activityFile: env.PI_SUBAGENT_ACTIVITY_FILE, text }, REPORT_MS);
	const answer = (details: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });

	pi.registerTool({
		name: "watch_read", label: "watch_read", description: READ_DESCRIPTION, defaultActive: false,
		parameters: Type.Object({
			key: Type.String({ minLength: 1, maxLength: 200, description: "The unit's key or session id, as your task gives it." }),
			since: Type.Optional(Type.String({ maxLength: 512, description: "The `since` of the last reply; none on the first call." })),
			waitMs: Type.Optional(Type.Number({ minimum: 1, maximum: WAIT_MAX_MS, description: `How long to wait for a change, in ms. Default ${WAIT_MS}; at most ${WAIT_MAX_MS}.` })),
			deadline: Type.Optional(Type.Number({ description: "Your task's time limit as an absolute time in ms; the reply at it is `expired`." })),
			quietMs: Type.Optional(Type.Number({ minimum: 60_000, description: "How long without activity counts as `stalled`, in ms. With none, nothing is `stalled`." })),
			loadMax: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "The load above which a monitor is `load`. Default: each monitor's own maximum." })),
		}),
		execute: async (_id, params, signal, onUpdate, ctx) => {
			const waitMs = params.waitMs ?? WAIT_MS;
			if (!(waitMs <= WAIT_MAX_MS)) throw new Error(`waitMs is at most ${WAIT_MAX_MS} (50 minutes)`);
			const end = Math.min(now() + waitMs, params.deadline ?? Infinity), pendingAtStart = ctx.hasPendingMessages();
			// An abort ends the call at once, not at the end of a hold of up to 45 s.
			const aborted = new Promise<never>((_resolve, reject) => (signal?.aborted ? reject(new Error(ABORTED)) : signal?.addEventListener("abort", () => reject(new Error(ABORTED)), { once: true })));
			aborted.catch(() => {});
			let since = params.since, last: Reply | undefined, trouble: { server: "unreachable" | "outdated"; error?: string } | undefined;
			for (let polls = 0; now() < end; polls++) {
				if (signal?.aborted) throw new Error(ABORTED);
				// Every re-poll moves the child's activity file, so pi-herdr-agents' hang advisory stays quiet through a long wait.
				if (polls) onUpdate?.(answer({ state: "unchanged", polls, ...trouble }));
				const left = end - now(), began = now();
				const reply = await Promise.race([call({ cmd: "watch-read", key: params.key, ...(since === undefined ? {} : { since }), ...(params.deadline === undefined ? {} : { deadline: params.deadline }), ...(params.quietMs === undefined ? {} : { quietMs: params.quietMs }), ...(params.loadMax === undefined ? {} : { loadMax: params.loadMax }) }, Math.min(REQUEST_MS, left)).catch(() => undefined), aborted]);
				if (reply?.ok) {
					const { ok: _ok, ...facts } = reply;
					if (facts.state !== "unchanged") return answer(facts);
					[last, trouble] = [reply, undefined];
					if (typeof reply.since === "string") since = reply.since; // the newest stamp records what was already returned
					// Only a message that arrived during this call ends it early: one already waiting at its start is a follow-up, which waits (AK4-F005).
					if (!pendingAtStart && ctx.hasPendingMessages()) break;
					if (now() - began < RETRY_MS && now() < end) await Promise.race([sleep(Math.min(RETRY_MS, end - now())), aborted]); // a server that holds nothing is not asked in a tight loop
					continue;
				}
				const error = typeof reply?.error === "string" ? reply.error : undefined;
				if (error?.startsWith("unknown key")) throw new Error(error);
				// A hold cut short at `end` by this call's own timeout is no failure of the server.
				if (reply || left >= REQUEST_MS || now() - began < left) trouble = error?.startsWith("unknown command") ? { server: "outdated" } : { server: "unreachable", ...(error ? { error } : {}) };
				// A server that restarts or upgrades, a socket error, a request cut off by a sleep: asked again, within the wait.
				if (now() < end) await Promise.race([sleep(Math.min(RETRY_MS, end - now())), aborted]);
			}
			const expired = params.deadline !== undefined && now() >= params.deadline;
			return answer({ state: expired ? "expired" : "unchanged", ...(since === undefined ? {} : { since }), now: now(), ...(last?.unit === undefined ? {} : { unit: last.unit }), ...trouble });
		},
	});
	pi.registerTool({
		name: "watch_report", label: "watch_report", description: REPORT_DESCRIPTION, defaultActive: false,
		parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 2000, description: "What happened, since when, and the fields that show it: 1 to 2000 plain characters." }) }),
		execute: async (_id, params) => {
			const reply = await report(params.text).catch(() => undefined);
			if (!reply) throw new Error("sb: the sb server did not answer, so the report was not sent. Call watch_report again.");
			if (!reply.ok) throw new Error(String(reply.error ?? "the sb server refused the report").startsWith("unknown command") ? "sb: the sb server is older than this watchdog and takes no report; a main's /reload upgrades it. Call watch_report again later." : String(reply.error ?? "the sb server refused the report"));
			return answer({ delivery: reply.delivery });
		},
	});

	// A first-launch watchdog outside Herdr records its role as one in Herdr does (index.ts registers childkind.ts only there), so its resume, which names no role, is still known.
	if (env.PI_SUBAGENT_AGENT === "watchdog" && !env.HERDR_PANE_ID) registerChildKind(pi, env);

	let dog: boolean | undefined, started = false, refused = false;
	/** Read once per session: the role of a first launch never changes, and a resume's entry is in its file before the session starts. A session that cannot be read is no watchdog's. */
	const watching = (ctx: ExtensionContext) => {
		if (dog === undefined) {
			try { dog = isWatchdog(env.PI_SUBAGENT_AGENT, ctx.sessionManager.getEntries()); } catch { dog = env.PI_SUBAGENT_AGENT === "watchdog"; }
		}
		return dog;
	};
	pi.on("session_start", (_event, ctx) => {
		[dog, started, refused] = [undefined, false, false];
		watching(ctx);
	});
	// The boundary (D3): it holds whatever `--tools` a spawn or a resume passed, and codemode's calls pass here too.
	pi.on("tool_call", (event, ctx) => {
		if (!watching(ctx) || WATCHDOG_TOOLS.includes(event.toolName)) return;
		return { block: true, reason: WATCHDOG_BLOCK };
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!watching(ctx)) return;
		if (!started) {
			started = true;
			// A spawn `tools` override that drops a watch tool leaves a watchdog that cannot watch: pi keeps an unlisted tool out of the registry. Its dispatcher is told, and the child ends.
			const have = new Set(pi.getAllTools().map((tool) => tool.name));
			if (!have.has("watch_read") || !have.has("watch_report")) {
				refused = true;
				await report(`sb: watchdog ${name} cannot start: its tool list lacks watch_read/watch_report (a spawn tools override?)`).catch(() => undefined);
			}
		}
		if (refused) {
			ctx.abort();
			ctx.shutdown();
			return { systemPrompt: EMPTY_REPLY };
		}
		// The model's view only (the block above is the boundary): every late registerTool re-widens the active set, so it is narrowed again at each run (AK3-F006).
		const active = pi.getActiveTools();
		if (active.some((tool) => !WATCHDOG_TOOLS.includes(tool))) pi.setActiveTools(active.filter((tool) => WATCHDOG_TOOLS.includes(tool)));
	});
}
