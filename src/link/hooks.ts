import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { decide, filterListing, readTracked, type Scope, searchRoot, type Tracked } from "./allow.ts";
import { type LinkConfig } from "./config.ts";
import { createLevelOf } from "./level.ts";
import { createGate, type ForwardPort } from "./gate.ts";
import { type PolicyDeps } from "./policy.ts";
import { hideOldRemote, Turns } from "./turn.ts";

// The hooks that make a run a remote turn and hold it to its level (docs/specs/2026-10-25-straw-link.md, Remote turns): the run classification, the
// `tool_call` allowlist and gate, the `tool_result` filter, and the `context` marker for later turns. They sit apart from the runtime so they run
// against a real pi agent session without Herdr (tests/link-session.test.ts).

export interface RemoteDeps {
	pi: ExtensionAPI;
	now: () => number;
	config: () => LinkConfig;
	policy?: PolicyDeps;
	home: string;
	agentDir: string;
	linkDir: string;
	gateMs?: number;
	/** Told when a remote turn starts or ends: `remote:<sender device id>` of its lowest-level sender, else undefined. */
	setOrigin: (origin: string | undefined) => void;
	/** The tower's own name, for the sender's alert. */
	tower: () => string;
	log: (event: Record<string, unknown>) => void;
	tell: (text: string, level?: "info" | "warning" | "error") => void;
	/** A request to the link holder (runtime.ts `ask`), for the confirm that `forward` sends to the sender's device. */
	ask: (op: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; [key: string]: unknown }>;
}

export function createRemoteTurns({ pi, now, config, policy: policyDeps, home, agentDir, linkDir, gateMs, setOrigin, tower, log, tell, ask }: RemoteDeps) {
	/** The level this computer gives a device: the policy file's on an unattended device, config.json's otherwise, `reply` when none names it. */
	const levelOf = createLevelOf({ config, policy: policyDeps, log, tell });
	const turns = new Turns(levelOf, () => void (setOrigin(turns.lowest ? `remote:${turns.lowest.id}` : undefined)));
	const trackedFor = new Map<string, { at: number; value: Tracked }>();
	/** The project every sender's team binds: a run that carries senders of several teams reads only where all of them may, and with different projects there is no such place. */
	const commonProject = (): string | undefined => {
		const projects = new Set(turns.list.map((s) => config().teams.get(s.team)?.project));
		return projects.size === 1 ? [...projects][0] : undefined;
	};
	const scopeFor = (cwd: string): Scope | undefined => {
		// With different projects there is no such place, so every call goes to the gate.
		const project = commonProject();
		if (!project) return undefined;
		return {
			project, cwd, home, agentDir, linkDir,
			tracked: () => {
				const hit = trackedFor.get(project);
				if (hit && now() - hit.at < 3000) return hit.value;
				const value = readTracked(project);
				trackedFor.set(project, { at: now(), value });
				return value;
			},
		};
	};
	// The sender's device is asked as well at `forward`: the request goes through the holder, and its answer comes back the same way.
	const forwardWaits = new Map<string, (allow: boolean) => void>();
	const answerForward = (dialogId: string, allow: boolean) => forwardWaits.get(dialogId)?.(allow);
	const forward: ForwardPort = {
		async send(req) {
			const answer = await ask({ op: "confirm-request", ...req });
			if (!answer.ok) throw new Error(answer.error);
		},
		listen(dialogId, on) {
			forwardWaits.set(dialogId, on);
			return () => (forwardWaits.delete(dialogId), void ask({ op: "forget-confirm", dialogId }).catch(() => undefined));
		},
	};
	const gate = createGate({ bus: pi.events, forward, timeoutMs: gateMs, onError: (what, error) => (log({ event: "gate-failed", what, error: error.message }), what === "forward" && tell(`Straw Link: the sender's device could not be asked to confirm (${error.message}); answer here`, "warning")) });
	/** Calls the gate let through: their output is the boss's to see whole. */
	const approved = new Set<string>();

	// A run is remote until pi says it settled (not at an agent_end: a retry, a compaction, or a queued message continues the run); a new session starts clean.
	pi.on("agent_settled", () => turns.settle());
	pi.on("session_start", () => turns.settle());
	pi.on("session_shutdown", () => (turns.settle(), gate.dispose()));
	pi.on("message_start", (e) => void turns.see(e.message));
	pi.on("message_end", (e) => void turns.see(e.message));
	pi.on("context", (e) => {
		const hidden = hideOldRemote(e.messages, turns);
		return hidden ? { messages: hidden } : undefined;
	});
	/** A failing tool_call hook blocks the call in pi (a tool_result hook's error lets the result through), so a failure while holding a remote turn must refuse explicitly: tool_call blocks, tool_result shows nothing. */
	const closed = (what: string, error: unknown) => {
		log({ event: "remote-hook-failed", what, error: String(error) });
		return `a remote request could not be checked (${what}); it is refused`;
	};
	pi.on("tool_call", async (e, ctx) => {
		if (!turns.active) return;
		try {
			return await held(e, ctx);
		} catch (error) {
			return { block: true, reason: closed("tool_call", error) };
		}
	});
	const held = async (e: ToolCallEvent, ctx: ExtensionContext) => {
		const input = e.input as Record<string, unknown>, level = turns.level!;
		if (e.toolName === "link_request") return { block: true, reason: "a remote turn cannot ask for a link action, whatever its sender's level" };
		// A peer could otherwise restart this computer's server: no level, dispatch included, may.
		if (e.toolName === "boss_server") return { block: true, reason: "a remote turn cannot see or restart this computer's sb server, whatever its sender's level" };
		if (level === "dispatch") return;
		const scope = scopeFor((ctx as { cwd?: string }).cwd ?? process.cwd());
		const verdict = scope ? decide(e.toolName, input, turns.list, scope) : ({ kind: "gate" } as const);
		if (verdict.kind === "allow") return;
		if (verdict.kind === "refuse") return { block: true, reason: verdict.reason };
		const lowest = turns.lowest;
		const outcome = await gate.ask({
			toolCallId: e.toolCallId, tool: e.toolName, input, senders: turns.list, tower: tower(),
			...(level === "forward" && lowest && lowest.id !== "?" ? { forwardTo: lowest } : {}),
			...(ctx.hasUI ? { ui: ctx.ui } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
		});
		if (!outcome.allow) return { block: true, reason: outcome.reason };
		approved.add(e.toolCallId);
	};
	pi.on("tool_result", (e, ctx) => {
		const asked = approved.delete(e.toolCallId);
		if (!turns.active || turns.level === "dispatch" || asked || !["grep", "find", "ls"].includes(e.toolName)) return;
		// content replaced without structuredContent: pi drops the structured copy, which would still hold what was filtered out.
		const show = (text: string) => ({ content: [{ type: "text" as const, text: text || "(nothing here that a remote request may see)" }] });
		try {
			const scope = scopeFor((ctx as { cwd?: string }).cwd ?? process.cwd());
			const text = e.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
			return show(scope ? filterListing(e.toolName, searchRoot(e.input, scope), text, scope) : "");
		} catch (error) {
			closed("tool_result", error);
			return show("");
		}
	});

	/** What a tool that answers a remote turn may show: the senders' teams, and the project they all bind. Undefined when the run is not remote. */
	const scope = () => (turns.active ? { teams: [...new Set(turns.list.map((s) => s.team))], project: commonProject() } : undefined);
	return { turns, answerForward, scope };
}
