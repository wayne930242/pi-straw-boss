import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeHost, type HostState } from "./host/state.ts";

// The doctor (docs/how-it-works.md#the-doctor): what a session's tools and loads are, and what to do when a tool the role needs is missing. It separates the three ways a tool goes
// missing that look the same from inside the model: the package never loaded in this process (H1), it registered the tool and something left it inactive (H2), or pi has it active and
// the provider does not show it (H3), plus a stale load (the process runs an older build than the one installed). Only facts go in; this module reads nothing of pi or Herdr itself,
// so the in-process tool (doctorlive.ts) and the out-of-process CLI (server/doctorcli.ts) share it.

export type DoctorRole = "main" | "member" | "train" | "tower" | "child" | "none";

/** The package that owns each tool the doctor expects: a tool is expected only when its package is in the settings, so a setup without it is not flagged. */
export const TOOL_PACKAGE: Readonly<Record<string, string>> = {
	subagent: "pi-herdr-agents", subagent_cancel: "pi-herdr-agents", subagent_send: "pi-herdr-agents", subagent_resume: "pi-herdr-agents", subagent_interrupt: "pi-herdr-agents", subagents_list: "pi-herdr-agents",
	caller_ping: "pi-herdr-agents", subagent_done: "pi-herdr-agents", intercom: "pi-intercom", todo: "pi-todo-ledger", MonitorCreate: "pi-loop-monitor",
};
const DISPATCH = ["subagent", "subagent_cancel", "subagent_send", "subagent_resume", "subagent_interrupt", "subagents_list"];
/** The tools of sb's own simple host (src/host/surface.ts), its child protocol too: pi-straw-boss owns them when its host registered. */
const SB_DISPATCH = ["subagent", "subagent_cancel", "subagent_resume", "subagents_list"];
const SB_CHILD = ["caller_ping", "subagent_done"];
const SHARED = ["intercom", "todo", "MonitorCreate"];
/** What each role must have active. pi-herdr-agents gives every session in a pane the same tools, so a member, a train and an unjoined session need what a main does; a tower runs
 * no subagent (runmode.ts blocks it), and a child has the child protocol on top, minus what its launch denied (PI_DENY_TOOLS). */
export const EXPECTED_TOOLS: Readonly<Record<DoctorRole, readonly string[]>> = {
	main: [...DISPATCH, ...SHARED], member: [...DISPATCH, ...SHARED], train: [...DISPATCH, ...SHARED], none: [...DISPATCH, ...SHARED], tower: SHARED, child: [...DISPATCH, ...SHARED, "caller_ping", "subagent_done"],
};

/** The branded global pi-herdr-agents writes at each load (its pi-extension/subagents/load-stamp.ts). */
export const LOAD_STAMP_KEY = Symbol.for("pi-herdr-agents/load-stamp");
export interface LoadStamp { wrapperVersion?: string; wrapperRoot?: string; wrapperHead?: string; maestroSpec?: string; maestroVersion?: string; maestroRoot?: string; maestroError?: string; loadedAt?: string; generation?: number; failed?: string }

export interface ToolFact { name: string; exposure?: string; source?: string }
export interface DoctorFacts {
	role: DoctorRole;
	/** PI_DENY_TOOLS of a child, split. */
	denied?: readonly string[];
	/** Package names in the settings (packageName of each entry). */
	packages: readonly string[];
	/** pi.getAllTools(), or a fresh load's tools out of process. */
	tools: readonly ToolFact[];
	/** pi.getActiveTools(); undefined out of process, where nothing is active. */
	active?: readonly string[];
	stamp?: LoadStamp;
	/** pi-herdr-agents as installed: the commit its settings entry pins and the checkout's HEAD. */
	installed?: { pin?: string; head?: string };
	pi?: { running?: string; installed?: string };
	provider?: string;
	model?: string;
	/** Load errors pi named (a fresh load's `getExtensions().errors`). */
	errors?: readonly { path: string; error: string }[];
	/** sb's subagent host in this process (src/host/state.ts), and the Maestro build it pins; undefined out of process. */
	host?: { state?: HostState; maestro?: string };
}

export type ToolState = "active" | "inactive" | "unregistered";
export type VerdictCode = "healthy" | "H1" | "H2" | "stale";
export interface DoctorReport {
	role: DoctorRole;
	expected: { name: string; package: string; state: ToolState }[];
	/** Expected tools not active, with their state. */
	missing: { name: string; package: string; state: ToolState }[];
	/** Tools and their count per source (the package entry), as pi grouped them. */
	loaded: Record<string, number>;
	/** Packages in the settings that own an expected tool and registered none in this process. */
	silent: string[];
	stamp?: LoadStamp;
	stale?: string;
	pi?: { running?: string; installed?: string };
	provider?: string;
	model?: string;
	errors: { path: string; error: string }[];
	verdict: VerdictCode;
	/** Who hosts subagents: sb's host (its state and Maestro build), or pi-herdr-agents. */
	host: { owner: "pi-straw-boss" | "pi-herdr-agents"; line?: string; maestro?: string };
	/** pi-intercom is not in the settings: the sb server cannot start, the host works. */
	intercom?: string;
	/** One line: what is wrong. */
	finding: string;
	/** One line: what to do next. */
	next: string;
	/** H3 cannot be told from inside: the note to call the tool directly when the model says it is missing. */
	note?: string;
}

/** The package name a settings entry names: `npm:@scope/name@1.2.3`, `git:github.com/owner/name@sha`, a local path, or `{ source }`. */
export function packageName(entry: unknown): string | undefined {
	const source = typeof entry === "string" ? entry : entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string" ? (entry as { source: string }).source : undefined;
	if (!source) return undefined;
	const bare = source.replace(/^(npm|git):/, "").replace(/\/+$/, "");
	const scoped = /^(@[^/]+\/[^@/]+)/.exec(bare);
	if (scoped && source.startsWith("npm:")) return scoped[1];
	const last = bare.split("/").pop() ?? bare;
	return last.replace(/@[^@]*$/, "").replace(/\.git$/, "") || undefined;
}

/** The commit a `git:` settings entry pins (`@<sha>`), when it pins one. */
export function pinOf(entry: unknown): string | undefined {
	return typeof entry === "string" ? /^git:.*@([0-9a-f]{7,40})$/.exec(entry)?.[1] : undefined;
}

export const agentDirOf = (env: NodeJS.ProcessEnv) => env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

/** The packages of the agent folder's settings.json; none when it cannot be read. */
export function settingsPackages(agentDir: string): unknown[] {
	try {
		const parsed = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { packages?: unknown };
		return Array.isArray(parsed.packages) ? parsed.packages : [];
	} catch {
		return [];
	}
}

/** Where pi installs a `git:` package: `<agentDir>/git/<host>/<owner>/<repo>`. */
export function gitInstallDir(agentDir: string, entry: unknown): string | undefined {
	const m = typeof entry === "string" ? /^git:([^@]+?)(?:\.git)?(?:@[^@]*)?$/.exec(entry) : undefined;
	return m ? join(agentDir, "git", ...m[1]!.split("/")) : undefined;
}

const DIRECT = new Set(["direct", "model-only", undefined]);
const short = (sha: string | undefined) => sha?.slice(0, 7);

/** Who registered the dispatch tools: sb's host when its state says it did (or, out of process, when `subagent` came from pi-straw-boss), else pi-herdr-agents. */
export function hostOwner(f: Pick<DoctorFacts, "host" | "tools">): "pi-straw-boss" | "pi-herdr-agents" {
	const state = f.host?.state?.state;
	if (state) return state === "off" || state === "stood-down" ? "pi-herdr-agents" : "pi-straw-boss";
	return f.tools.some((t) => t.name === "subagent" && t.source && packageName(t.source) === "pi-straw-boss") ? "pi-straw-boss" : "pi-herdr-agents";
}
const sbExpected = (role: DoctorRole) => (role === "tower" ? EXPECTED_TOOLS.tower : [...SB_DISPATCH, ...SHARED, ...(role === "child" ? SB_CHILD : [])]);

export function diagnose(f: DoctorFacts): DoctorReport {
	const owner = hostOwner(f), sb = owner === "pi-straw-boss";
	const installed = new Set([...f.packages, ...(sb ? ["pi-straw-boss"] : [])]), denied = new Set(f.role === "child" ? f.denied ?? [] : []);
	const packageOf = (name: string) => (sb && (SB_DISPATCH.includes(name) || SB_CHILD.includes(name)) ? "pi-straw-boss" : TOOL_PACKAGE[name]!);
	const byName = new Map(f.tools.map((t) => [t.name, t]));
	const active = f.active ? new Set(f.active) : undefined;
	const loaded: Record<string, number> = {};
	for (const t of f.tools) if (t.source) loaded[t.source] = (loaded[t.source] ?? 0) + 1;
	const stateOf = (name: string): ToolState => {
		const tool = byName.get(name);
		if (!tool) return "unregistered";
		// A deferred or codemode tool is reachable without being active; out of process nothing is active, and a registered tool is all a fresh load can show.
		return !active || active.has(name) || !DIRECT.has(tool.exposure) ? "active" : "inactive";
	};
	const expected = (sb ? sbExpected(f.role) : EXPECTED_TOOLS[f.role]).filter((name) => installed.has(packageOf(name)) && !denied.has(name)).map((name) => ({ name, package: packageOf(name), state: stateOf(name) }));
	const missing = expected.filter((t) => t.state !== "active");
	const owners = new Set(expected.map((t) => t.package));
	const sourceOf = (pkg: string) => (t: ToolFact) => packageOf(t.name) === pkg || Boolean(t.source && packageName(t.source) === pkg);
	const silent = [...owners].filter((pkg) => !f.tools.some(sourceOf(pkg)));
	const stamp = f.stamp, pin = f.installed?.pin, head = f.installed?.head;
	let stale: string | undefined;
	if (!sb && installed.has("pi-herdr-agents") && stamp?.wrapperHead && (pin || head)) {
		const want = pin ?? head!;
		if (!stamp.wrapperHead.startsWith(want) && !want.startsWith(stamp.wrapperHead)) stale = `pi-herdr-agents ${short(stamp.wrapperHead)} is loaded, ${short(want)} is installed`;
	}
	if (!stale && f.pi?.running && f.pi.installed && f.pi.running !== f.pi.installed) stale = `pi ${f.pi.running} runs, ${f.pi.installed} is installed`;
	const errors = [...(f.errors ?? [])];
	const host = { owner, ...(f.host?.state || f.host ? { line: describeHost(f.host?.state) } : {}), ...(f.host?.maestro ? { maestro: f.host.maestro } : {}) };
	// The sb server needs pi-intercom (its sessions, the net, the GUI); the subagent host does not. A plain npm install brings no pi-intercom.
	const intercom = f.host && !f.packages.includes("pi-intercom") && !f.tools.some((t) => t.name === "intercom") ? "pi-intercom is not installed: the sb server, the net and the GUI need it (pi install npm:pi-intercom); the subagent host works without it." : undefined;
	const base = { role: f.role, expected, missing, loaded, silent, stamp, stale, pi: f.pi, provider: f.provider, model: f.model, errors, host, ...(intercom ? { intercom } : {}) };
	const list = (ts: { name: string }[]) => ts.map((t) => t.name).join(", ");
	const unregistered = missing.filter((t) => t.state === "unregistered"), inactive = missing.filter((t) => t.state === "inactive");
	if (unregistered.length || stamp?.failed) {
		const why = stamp?.failed ? `its load threw: ${stamp.failed}` : silent.length ? `${silent.join(", ")} registered nothing in this process` : "its package registered other tools but not these";
		return { ...base, verdict: "H1", finding: `${list(unregistered) || owner} not registered: ${why}${errors.length ? `; pi names ${errors.length} load error${errors.length > 1 ? "s" : ""}` : ""}.`, next: "Hand this work over to a fresh session (a /reload does not cure state a process keeps); do not route around it with plain panes." };
	}
	if (inactive.length) return { ...base, verdict: "H2", finding: `${list(inactive)} registered but not active: an extension's setActiveTools left ${inactive.length > 1 ? "them" : "it"} out.`, next: "Run /boss doctor fix to make them active again, or /reload." };
	if (stale) return { ...base, verdict: "stale", finding: `Stale load: ${stale}.`, next: "Finish the turn, then /reload, or hand over to a fresh session if a reload already failed." };
	const note = f.provider === "claude-bridge" ? "Every expected tool is active in pi. If the model still says one is missing (H3 possible through claude-bridge), call it directly, e.g. subagents_list, before concluding anything." : undefined;
	return { ...base, verdict: "healthy", finding: expected.length ? `All ${expected.length} expected tools are active.` : "No expected tool: none of their packages is in the settings.", next: "Nothing to do.", ...(note ? { note } : {}) };
}

/** The report as a few lines for a person or a model. */
export function renderDoctor(r: DoctorReport): string {
	const lines = [`sb doctor: ${r.verdict} (${r.role})`, r.finding, `Next: ${r.next}`];
	if (r.note) lines.push(r.note);
	if (r.missing.length) lines.push(`Missing: ${r.missing.map((t) => `${t.name} ${t.state} (${t.package})`).join("; ")}`);
	if (r.host.line) lines.push(`Subagent host: ${r.host.line}`);
	if (r.host.maestro) lines.push(r.host.maestro);
	if (r.intercom) lines.push(r.intercom);
	const loader = r.host.owner === "pi-straw-boss" ? "sb host" : "pi-herdr-agents";
	if (r.stamp) lines.push(`${loader} load: ${r.stamp.wrapperVersion ?? "?"} @${short(r.stamp.wrapperHead) ?? "?"}, maestro ${r.stamp.maestroVersion ?? "?"}, generation ${r.stamp.generation ?? "?"}, at ${r.stamp.loadedAt ?? "?"}${r.stamp.failed ? `, failed: ${r.stamp.failed}` : ""}`);
	else if (r.expected.some((t) => t.package === r.host.owner && DISPATCH.includes(t.name))) lines.push(`${loader} load: no stamp (a build before the stamp, or it never loaded)`);
	if (r.stale) lines.push(`Stale: ${r.stale}`);
	if (r.pi?.running || r.pi?.installed) lines.push(`pi: ${r.pi.running ?? "?"} running, ${r.pi.installed ?? "?"} installed`);
	if (r.provider || r.model) lines.push(`Model: ${r.provider ?? "?"}/${r.model ?? "?"}`);
	for (const e of r.errors.slice(0, 5)) lines.push(`Load error: ${e.path}: ${e.error.split("\n")[0]}`);
	return lines.join("\n");
}

/** The session_start self-check's message, or undefined when every expected tool is active, and for a child, whose tools are its launch's choice (a role's tool list, auto-exit without
 * subagent_done) and whose parent supervises it: a child told to hand over stopped before its work. */
export function selfCheckText(r: DoctorReport): string | undefined {
	if (r.role === "child" || (!r.missing.length && r.verdict !== "H1")) return undefined;
	const first = r.missing[0];
	const what = first ? `\`${first.name}\` is not active (registered: ${first.state === "unregistered" ? "no" : "yes"}${r.silent.length ? `; ${r.silent.join(", ")} loaded nothing` : ""})` : `${r.host.owner} failed to load (${r.stamp?.failed})`;
	const more = r.missing.length > 1 ? `, with ${r.missing.slice(1).map((t) => t.name).join(", ")}` : "";
	return `sb self-check: ${what}${more}. Do not route around it with plain panes; run sb_doctor (or /boss doctor) and ${r.verdict === "H2" ? "follow its next step" : "hand over to a fresh session"}.`;
}
