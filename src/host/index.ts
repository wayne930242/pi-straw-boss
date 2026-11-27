/**
 * sb's subagent host entry (docs/how-it-works.md#the-subagent-host). It imports no Maestro module in the factory. The host is selected by
 * `PI_STRAW_BOSS_HOST`, then `<agentDir>/straw-boss/host.json`, then `~/.pi/agent/straw-boss/host.json` (a child Maestro points at a local agent dir
 * still finds the home file), else on: the boss chose dispatch on for a plain npm install.
 *
 * A selected host registers nothing in the factory. At session start every extension has registered, so it reads Pi's record of who registered
 * `subagent` (rivals.ts): when pi-herdr-agents, or another copy of sb, did, sb stands down, registers nothing and says so once; otherwise it loads the
 * engine through a late API (late.ts) and hands it this session start. Load order is never consulted.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { localeOf } from "../locale.ts";
import { retiredWarning } from "./retired.ts";
import { lateApi } from "./late.ts";
import { rivalsOf, rivalText } from "./rivals.ts";
import { setHostState } from "./state.ts";

export type HostChoice = "sb" | "off";

const parse = (value: unknown): HostChoice | undefined => (value === "sb" || value === "off" ? value : undefined);

function readChoice(file: string): HostChoice | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const host = parse((JSON.parse(text) as { host?: unknown }).host);
	if (!host) throw new Error(`pi-straw-boss: ${file} names no host ("sb" or "off")`);
	return host;
}

/** Which host this load runs, and where the answer came from. */
export function hostChoice(env: NodeJS.ProcessEnv = process.env, agentDir = getAgentDir(), home = homedir()): { host: HostChoice; from: string } {
	const fromEnv = env.PI_STRAW_BOSS_HOST;
	if (fromEnv !== undefined) {
		const host = parse(fromEnv);
		if (!host) throw new Error(`pi-straw-boss: PI_STRAW_BOSS_HOST=${fromEnv} names no host ("sb" or "off")`);
		return { host, from: "PI_STRAW_BOSS_HOST" };
	}
	for (const file of [...new Set([join(agentDir, "straw-boss", "host.json"), join(home, ".pi", "agent", "straw-boss", "host.json")])]) {
		const host = readChoice(file);
		if (host) return { host, from: file };
	}
	return { host: "sb", from: "default" };
}

/** The sb package root: registrations under it are sb's own. */
const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");

export interface HostDeps {
	choice?: () => { host: HostChoice; from: string };
	/** The engine's loader; the tests give a fake one. */
	engine?: () => Promise<(pi: ExtensionAPI) => void>;
	root?: string;
}

export function createHost(deps: HostDeps = {}) {
	return function strawBossHost(pi: ExtensionAPI): void {
		const { host, from } = (deps.choice ?? hostChoice)();
		if (host !== "sb") return void setHostState({ state: "off", from });
		setHostState({ state: "pending", from });
		const late = lateApi(pi);
		let decided: "active" | "down" | undefined;
		let retired: ReturnType<typeof rivalsOf> = [];
		const warned = new Set<string>();
		pi.on("session_start", async (event, ctx) => {
			const tell = (text: string) => {
				if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(text, "warning");
				else console.error(text);
			};
			const warnRetired = () => {
				const session = ctx.sessionManager.getSessionId();
				if (warned.has(session)) return;
				warned.add(session);
				tell(retiredWarning(retired, localeOf(process.env, join(getAgentDir(), "straw-boss"))));
			};
			if (retired.length) return warnRetired();
			if (!decided) {
				const rivals = rivalsOf(pi.getCommands(), pi.getAllTools(), deps.root ?? ROOT);
				if (rivals.length) {
					decided = "down";
					const why = `${rivalText(rivals)}, so sb's subagent host registered nothing in this pi`;
					setHostState({ state: "stood-down", from, why, others: rivals.map((r) => r.path) });
					retired = rivals.filter(r => r.pkg === "pi-herdr-agents");
					if (retired.length) warnRetired();
					else tell(`Straw Boss: ${why}. Remove one of the two hosts (see /boss doctor).`);
					return;
				}
				try {
					const load = await (deps.engine ?? (async () => (await import("./engine.ts")).default))();
					load(late.api);
					decided = "active";
					setHostState({ state: "active", from });
				} catch (error) {
					decided = "down";
					const message = error instanceof Error ? error.message : String(error);
					setHostState({ state: "failed", from, error: message });
					ctx.ui.notify(`Straw Boss: the subagent host failed to load: ${message}`, "error");
					return;
				}
			}
			if (decided === "active") await late.run("session_start", event, ctx);
		});
	};
}

export default createHost();
