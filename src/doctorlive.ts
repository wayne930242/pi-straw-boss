import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getPackageDir, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runCount } from "./trackedruns.ts";
import { execFileSyncExe } from "./exe.mjs";
import { agentDirOf, diagnose, type DoctorFacts, type DoctorReport, type DoctorRole, gitInstallDir, LOAD_STAMP_KEY, type LoadStamp, packageName, pinOf, renderDoctor, selfCheckText, settingsPackages } from "./doctor.ts";

// The doctor in this process (docs/how-it-works.md#the-doctor): the sb_doctor tool, /boss doctor (boss.ts), and the self-check at each session start. Every session in a pane gets the
// self-check, a child too, which never warns (doctor.ts selfCheckText); the tool and the command go to the sessions that are no child. What this process has is read here; what it means is doctor.ts's.

export const DOCTOR_MESSAGE = "sb-doctor";
const DESCRIPTION = "Check this session's own tools and loads: whether subagent, intercom, todo and MonitorCreate are registered and active, whether pi-herdr-agents loaded and is current, and what to do. Call it before concluding a tool is missing.";

export interface DoctorDeps {
	env: NodeJS.ProcessEnv;
	role: () => DoctorRole;
	/** A visible line for the person at the pane. */
	tell?: (text: string, level: "info" | "warning" | "error") => void;
	/** HEAD of a checkout (git rev-parse), for the stale check; undefined when it cannot be read. */
	headOf?: (dir: string) => string | undefined;
	/** The version of the pi installed on disk now (its package.json), against the one running. */
	piInstalled?: () => string | undefined;
	/** What this session's worker revives wait on (childrevive.ts `waits`). */
	revives?: () => readonly string[];
}

const gitHead = (dir: string) => {
	try {
		return String(execFileSyncExe("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] })).trim() || undefined;
	} catch {
		return undefined;
	}
};
const diskPi = () => {
	try {
		return (JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf8")) as { version?: string }).version;
	} catch {
		return undefined;
	}
};

/** What this process has: its tools, active set, the load stamp, the settings, and, with `deep`, the installed builds (a git call and a file read). */
export function liveFacts(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "model"> | undefined, d: DoctorDeps, deep: boolean): DoctorFacts {
	const agentDir = agentDirOf(d.env), entries = settingsPackages(agentDir), herdr = entries.find((e) => packageName(e) === "pi-herdr-agents");
	const stamp = (globalThis as Record<symbol, LoadStamp | undefined>)[LOAD_STAMP_KEY];
	const install = deep && herdr !== undefined ? gitInstallDir(agentDir, herdr) : undefined;
	return {
		role: d.role(),
		denied: (d.env.PI_DENY_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
		packages: entries.map(packageName).filter((n): n is string => Boolean(n)),
		tools: pi.getAllTools().map((t) => ({ name: t.name, exposure: t.exposure, source: t.sourceInfo?.source })),
		active: pi.getActiveTools(),
		...(stamp ? { stamp } : {}),
		...(deep ? { trackedRuns: runCount(pi.events), revives: d.revives?.() ?? [], installed: { pin: pinOf(herdr), head: install ? (d.headOf ?? gitHead)(install) : undefined }, pi: { running: PI_VERSION, installed: (d.piInstalled ?? diskPi)() } } : {}),
		provider: ctx?.model?.provider,
		model: ctx?.model?.id,
	};
}

export interface Doctor {
	/** Registers sb_doctor, once: at the join, as the other net tools are (a session off the net registers no tool). */
	addTool(): void;
	report(ctx: Pick<ExtensionContext, "model"> | undefined): DoctorReport;
	/** H2's fix: the expected tools that are registered and inactive are made active again; the names it added. */
	fix(): string[];
}

/** Registers the self-check; `addTool` adds the sb_doctor tool. */
export function registerDoctor(pi: ExtensionAPI, d: DoctorDeps): Doctor {
	const report = (ctx: Pick<ExtensionContext, "model"> | undefined, deep = true) => diagnose(liveFacts(pi, ctx, d, deep));
	// The self-check runs at the first turn after each session start (startup, reload, new, resume, fork): by then every extension has registered its tools, and the message goes in with that
	// turn's prompt. One per session start.
	let pending = false;
	pi.on("session_start", () => void (pending = true));
	pi.on("before_agent_start", (_event, ctx) => {
		if (!pending) return;
		pending = false;
		const text = selfCheckText(report(ctx, false));
		if (!text) return;
		if (ctx?.hasUI) ctx.ui.notify(text, "warning");
		else d.tell?.(text, "warning");
		return { message: { customType: DOCTOR_MESSAGE, content: text, display: true } };
	});
	let added = false;
	const addTool = () => {
		if (added) return;
		added = true;
		pi.registerTool({
			name: "sb_doctor", label: "sb_doctor", description: DESCRIPTION, parameters: Type.Object({}),
			execute: async (_id, _params, _signal, _update, ctx) => {
				const r = report(ctx);
				return { content: [{ type: "text", text: renderDoctor(r) }], details: r };
			},
		});
	};
	return {
		addTool,
		report,
		fix: () => {
			const r = report(undefined, false), add = r.missing.filter((t) => t.state === "inactive").map((t) => t.name);
			if (add.length) pi.setActiveTools([...new Set([...pi.getActiveTools(), ...add])]);
			return add;
		},
	};
}
