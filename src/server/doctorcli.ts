import { execFile } from "node:child_process";
import { execFileExe } from "../exe.mjs";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentDirOf, diagnose, type DoctorReport, type DoctorRole, gitInstallDir, type LoadStamp, packageName, pinOf, renderDoctor, settingsPackages, TOOL_PACKAGE, type ToolFact } from "../doctor.ts";
import type { HerdrRun, Pane } from "../herdr.ts";

// `cli.mjs doctor --session <id | prefix | pane>` (docs/how-it-works.md#the-doctor): the doctor for another session, from outside it. It cannot read that process's tools, so it gathers
// what can be read: a fresh headless load of the same folder and settings (pi's own DefaultResourceLoader, in a child node with the session's environment dropped, so its errors are
// pi's), the session file (the tool calls pi answered "No such tool available", the model), Herdr's pane and the pi process's start, and the installed pi-herdr-agents. A tool the fresh
// load has and the live session was refused is a fault of that process: H1 or H3, which only the in-process sb_doctor tells apart. Kept out of cli.ts, which carries a line budget.

export interface FreshLoad { pi?: string; errors: { path: string; error: string }[]; tools: ToolFact[]; stamp?: LoadStamp }
export interface DoctorCliDeps {
	env: NodeJS.ProcessEnv;
	run: HerdrRun;
	/** The headless load; by default a child node that imports the pi found on PATH. */
	load?: (cwd: string, agentDir: string) => Promise<FreshLoad>;
	headOf?: (dir: string) => Promise<string | undefined>;
	/** The start time of a process (ms), by default from `ps`. */
	startOf?: (pid: number) => Promise<number | undefined>;
}
export interface Refusal { tool: string; at?: string }
export interface OutReport extends Omit<DoctorReport, "verdict"> {
	verdict: DoctorReport["verdict"] | "H1-or-H3";
	session: { id?: string; file: string; cwd?: string; pane?: string; status?: string; startedAt?: string };
	/** Expected tools pi answered "No such tool available" in this session, the last time each. */
	refused: Refusal[];
	freshStamp?: LoadStamp;
	installedAt?: string;
}

const NO_TOOL = /No such tool available: (?:mcp__[^_]+(?:-[^_]+)*__)?([A-Za-z0-9_]+)/g;
const sh = (name: "git" | "ps", args: string[], deadline = 10_000) => new Promise<string>((resolve, reject) => void execFileExe(name, args, { deadline, maxBuffer: 32 << 20 }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
/** pi's package name, built so the server bundle carries no quoted import of it (scripts/build-server.mjs fails a bundle that names one of pi's packages). */
const PI_PACKAGE = ["@earendil-works", "pi-coding-agent"].join("/");

/** The pi package root from the `pi` on PATH, or undefined. */
export function piRootOf(env: NodeJS.ProcessEnv): string | undefined {
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		const bin = join(dir, "pi");
		if (!existsSync(bin)) continue;
		for (let at = dirname(realpathSync(bin)); dirname(at) !== at; at = dirname(at)) {
			const pkg = join(at, "package.json");
			if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name === PI_PACKAGE) return at;
		}
	}
	return undefined;
}

// Run as `node --input-type=module -e`: it imports pi by file URL, loads the extensions the settings name for the folder, and prints what they registered and the errors pi named.
const LOAD_SCRIPT = `const pi = await import(process.env.SB_DOCTOR_PI);
const loader = new pi.DefaultResourceLoader({ cwd: process.env.SB_DOCTOR_CWD, agentDir: process.env.SB_DOCTOR_AGENT_DIR, packageCommandOutput: "capture", noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload();
const r = loader.getExtensions();
const tools = r.extensions.flatMap((e) => [...e.tools.entries()].map(([name, t]) => ({ name, exposure: t.definition?.exposure, source: e.sourceInfo?.source })));
process.stdout.write("\\nSB_DOCTOR " + JSON.stringify({ pi: pi.VERSION, errors: r.errors, tools, stamp: globalThis[Symbol.for("pi-herdr-agents/load-stamp")] }) + "\\n");
process.exit(0);`;
/** What a session's environment adds that would make the fresh load act as that session (join a net, claim a pane, act as a child). */
const DROP = /^(HERDR_|PI_SUBAGENT|PI_INTERCOM|PI_DENY_TOOLS|STRAW_BOSS_)/;

export const freshLoad = (env: NodeJS.ProcessEnv) => async (cwd: string, agentDir: string): Promise<FreshLoad> => {
	const root = piRootOf(env);
	if (!root) throw new Error("no pi on PATH: the fresh load needs pi's own loader");
	const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !DROP.test(k)));
	const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, ["--input-type=module", "-e", LOAD_SCRIPT], { cwd, timeout: 120_000, maxBuffer: 32 << 20, env: { ...clean, SB_DOCTOR_PI: pathToFileURL(join(root, "dist", "index.js")).href, SB_DOCTOR_CWD: cwd, SB_DOCTOR_AGENT_DIR: agentDir } }, (error, stdout, stderr) => (error ? reject(new Error(`the fresh load failed: ${error.message}${stderr ? `\n${stderr.slice(-2000)}` : ""}`)) : resolve(stdout))));
	const line = out.split("\n").reverse().find((l) => l.startsWith("SB_DOCTOR "));
	if (!line) throw new Error("the fresh load printed no result");
	return JSON.parse(line.slice("SB_DOCTOR ".length)) as FreshLoad;
};

const startByPs = async (pid: number) => {
	const text = (await sh("ps", ["-o", "lstart=", "-p", String(pid)]).catch(() => "")).trim();
	const ms = text ? Date.parse(text) : Number.NaN;
	return Number.isNaN(ms) ? undefined : ms;
};

/** The session file: a pane's (Herdr's agent_session), or one under `<agentDir>/sessions` whose id starts with the query. */
export function findSession(query: string, ps: Pane[], agentDir: string): { file: string; pane?: Pane } {
	const pane = ps.find((p) => p.pane_id === query);
	if (pane) {
		if (!pane.agent_session?.value) throw new Error(`pane ${query} runs no pi session Herdr knows`);
		return { file: pane.agent_session.value, pane };
	}
	const root = join(agentDir, "sessions"), found: string[] = [];
	for (const dir of existsSync(root) ? readdirSync(root) : []) {
		const full = join(root, dir);
		if (!statSync(full).isDirectory()) continue;
		for (const name of readdirSync(full)) if (name.endsWith(".jsonl") && (name.split("_")[1] ?? "").startsWith(query)) found.push(join(full, name));
	}
	if (!found.length) throw new Error(`no session file under ${root} has an id starting with ${query}`);
	if (found.length > 1) throw new Error(`${found.length} sessions start with ${query}; give more of the id:\n  ${found.map((f) => basename(f)).join("\n  ")}`);
	return { file: found[0]!, pane: ps.find((p) => p.agent_session?.value === found[0]) };
}

/** What a session file says: its header, the last model, and the expected tools pi refused (with when). */
export function readSession(file: string): { id?: string; cwd?: string; provider?: string; model?: string; refused: Refusal[] } {
	const out: { id?: string; cwd?: string; provider?: string; model?: string; refused: Refusal[] } = { refused: [] };
	const last = new Map<string, string | undefined>();
	for (const raw of readFileSync(file, "utf8").split("\n")) {
		if (!raw) continue;
		let entry: { type?: string; id?: string; cwd?: string; provider?: string; modelId?: string; timestamp?: string; message?: { role?: string; provider?: string; model?: string } };
		try {
			entry = JSON.parse(raw);
		} catch {
			continue;
		}
		if (entry.type === "session") Object.assign(out, { id: entry.id, cwd: entry.cwd });
		if (entry.type === "model_change") Object.assign(out, { provider: entry.provider, model: entry.modelId });
		if (entry.message?.role === "assistant" && entry.message.provider) Object.assign(out, { provider: entry.message.provider, model: entry.message.model });
		if (!raw.includes("No such tool available")) continue;
		for (const m of raw.matchAll(NO_TOOL)) if (TOOL_PACKAGE[m[1]!]) last.set(m[1]!, entry.timestamp);
	}
	out.refused = [...last].map(([tool, at]) => ({ tool, ...(at ? { at } : {}) }));
	return out;
}

const roleOf = (pane: Pane | undefined): DoctorRole => {
	const t = pane?.tokens ?? {};
	if (Object.keys(t).some((k) => k.startsWith("piha_"))) return "child";
	const r = t.sb_role ?? (t.sb_train ? "train" : undefined);
	return r === "main" || r === "member" || r === "tower" || r === "train" ? r : "none";
};

export async function doctorFor(query: string, d: DoctorCliDeps): Promise<OutReport> {
	const agentDir = agentDirOf(d.env);
	const ps = await d.run(["pane", "list"]).then((t) => (JSON.parse(t) as { result?: { panes?: Pane[] } }).result?.panes ?? []).catch(() => [] as Pane[]);
	const { file, pane } = findSession(query, ps, agentDir);
	const s = readSession(file), cwd = s.cwd ?? pane?.cwd;
	if (!cwd) throw new Error(`${file} names no folder, and no pane holds it`);
	const entries = settingsPackages(agentDir), herdr = entries.find((e) => packageName(e) === "pi-herdr-agents"), install = herdr !== undefined ? gitInstallDir(agentDir, herdr) : undefined;
	const [fresh, head] = await Promise.all([(d.load ?? freshLoad(d.env))(cwd, agentDir), install ? (d.headOf ?? ((dir) => sh("git", ["-C", dir, "rev-parse", "HEAD"]).then((t) => t.trim(), () => undefined)))(install) : undefined]);
	const installedMs = install && existsSync(join(install, ".git", "HEAD")) ? statSync(join(install, ".git", "HEAD")).mtimeMs : undefined;
	let startedMs: number | undefined;
	if (pane) {
		const info = await d.run(["pane", "process-info", "--pane", pane.pane_id]).then((t) => (JSON.parse(t) as { result?: { process_info?: { foreground_process_group_id?: number } } }).result?.process_info, () => undefined);
		const pid = info?.foreground_process_group_id;
		if (pid) startedMs = await (d.startOf ?? startByPs)(pid);
	}
	const role = roleOf(pane);
	const base = diagnose({ role, packages: entries.map(packageName).filter((n): n is string => Boolean(n)), tools: fresh.tools, installed: { pin: pinOf(herdr), head }, pi: { installed: fresh.pi }, provider: s.provider, model: s.model, errors: fresh.errors, ...(fresh.stamp ? { stamp: fresh.stamp } : {}) });
	const expected = new Set(base.expected.map((t) => t.name));
	const refused = s.refused.filter((r) => expected.has(r.tool) && (!startedMs || !r.at || Date.parse(r.at) >= startedMs));
	const session = { id: s.id, file, cwd, ...(pane ? { pane: pane.pane_id, status: pane.agent_status } : {}), ...(startedMs ? { startedAt: new Date(startedMs).toISOString() } : {}) };
	const report: OutReport = { ...base, session, refused, freshStamp: fresh.stamp, ...(installedMs ? { installedAt: new Date(installedMs).toISOString() } : {}) };
	delete report.stamp;
	delete report.note; // "active in pi" is a fact of the process, which a fresh load is not
	const staleLive = startedMs && installedMs && startedMs < installedMs ? `its pi started ${new Date(startedMs).toISOString()}, before pi-herdr-agents ${head?.slice(0, 7) ?? ""} was installed ${new Date(installedMs).toISOString()}` : undefined;
	if (staleLive) report.stale = report.stale ? `${report.stale}; ${staleLive}` : staleLive;
	if (base.verdict !== "healthy") return report;
	if (refused.length) {
		const names = refused.map((r) => `${r.tool}${r.at ? ` (last ${r.at})` : ""}`).join(", ");
		return { ...report, verdict: "H1-or-H3", finding: `A fresh load registers every expected tool, but this session was refused ${names}${pane ? "" : " (no pane holds it now)"}${staleLive ? `; ${staleLive}` : ""}. The fault is in that process: H1 (its load of pi-herdr-agents failed) or H3 (the provider does not show it).`, next: "Hand its work over to a fresh session. To tell H1 from H3 first, run sb_doctor (or /boss doctor) inside it, once this sb is loaded there." };
	}
	if (staleLive) return { ...report, verdict: "stale", finding: `Stale load: ${staleLive}.`, next: "Have it finish the turn, then /reload, or hand over to a fresh session if a reload already failed." };
	return report;
}

export function renderOut(r: OutReport): string {
	// The stamp line is the live process's, which this cannot read: the fresh load's stamp has a line of its own.
	const head = renderDoctor({ ...r, verdict: r.verdict as DoctorReport["verdict"] }).split("\n").filter((l) => !l.startsWith("pi-herdr-agents load:"));
	const s = r.session;
	head.splice(1, 0, `Session ${s.id ?? "?"} ${s.pane ? `in pane ${s.pane} (${s.status ?? "?"})` : "(no pane holds it)"}${s.startedAt ? `, pi started ${s.startedAt}` : ""}; ${s.file}`);
	if (r.refused.length) head.push(`Refused in the session: ${r.refused.map((x) => `${x.tool}${x.at ? ` at ${x.at}` : ""}`).join(", ")}`);
	if (r.freshStamp) head.push(`Fresh load: pi-herdr-agents ${r.freshStamp.wrapperVersion ?? "?"} @${r.freshStamp.wrapperHead?.slice(0, 7) ?? "?"}${r.installedAt ? `, installed ${r.installedAt}` : ""}`);
	return head.join("\n");
}

export interface DoctorIo { out(text: string): void; err(text: string): void }
/** Exit codes: 0 healthy; 1 a fault was found, or the doctor could not look (stderr says why). */
export async function runDoctor(flags: Record<string, string | true>, d: DoctorCliDeps, io: DoctorIo): Promise<number> {
	let report: OutReport;
	try {
		report = await doctorFor(String(flags.session), d);
	} catch (error) {
		io.err(`${(error as Error).message}\n`);
		return 1;
	}
	io.out(flags.json === true ? `${JSON.stringify(report)}\n` : `${renderOut(report)}\n`);
	return report.verdict === "healthy" ? 0 : 1;
}
