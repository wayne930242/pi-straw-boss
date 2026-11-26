// The worker slip (docs/specs/2026-11-26-ally-workers.md): the first line of a message a controller main sends with `call_tower` `worker`, written by code on the controller and read again by code on the box.
//   worker: <label> | branch: <branch> | base: <ref> | model: <id> | points: <n>
//   worker: <label> | resume: <session uuid> [| branch: <b>] [| model: <id>] [| points: <n>]   (a follow-up to a worker that ended, by its full session id)
// `base`, `model` and `points` may be left out (the box picks the base, pi's default model, 1 point). The brief follows the line unchanged. Pure: the git checks of the branch and base are the box's (server/workeropen.ts).

export interface WorkerSpec { label: string; branch: string; base?: string; model?: string; points: number; resume?: undefined }
/** A resume slip: `branch` only cross-checks the box's record, and `points` or `model` left out are the record's (the session's own model). */
export interface ResumeSpec { label: string; resume: string; branch?: string; model?: string; points?: number }
export type Slip = WorkerSpec | ResumeSpec;
/** A pi session id as the receipts print it: the full uuid, never a prefix and never a path. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const WORKER_DEFAULT_POINTS = 1, WORKER_MIN_POINTS = 0.25, WORKER_MAX_POINTS = 10, WORKER_BRIEF_MAX = 60_000;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/, MODEL = /^[A-Za-z0-9._:/@-]{1,120}$/, BASE = /^(?:[0-9a-f]{40}|[A-Za-z0-9._/-]{1,100})$/, KEYS = ["worker", "resume", "branch", "base", "model", "points"] as const;
/** Branches a worker never takes: the integration lines and the trains' (apps.json `integration` adds its own on the box). */
const RESERVED = [/^(?:main|master|develop|HEAD)$/i, /^release\//, /^pre-dev\//, /^train-/, /^agent-train\//, /^train\//];

/** Why a branch name is refused, or nothing: the pattern, no `..`, `//`, `@{`, a leading `-` or `/`, a trailing `/`, `.` or `.lock`, no component that starts with `.`, and no reserved name. */
export function branchProblem(b: string, reserved: readonly string[] = []): string | undefined {
	if (!BRANCH.test(b)) return "must be 1 to 100 of A-Z a-z 0-9 . _ / -";
	if (b.startsWith("-") || b.startsWith("/") || b.endsWith("/") || b.endsWith(".") || b.endsWith(".lock") || b.includes("..") || b.includes("//") || b.split("/").some((c) => c.startsWith("."))) return "is not a branch name git takes";
	if (RESERVED.some((r) => r.test(b)) || reserved.includes(b)) return "is an integration or train branch, which a worker never takes";
	return undefined;
}
/** Points as the box keeps them: 0.25 to 10 in quarter steps; none given is 1. */
export const clampPoints = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? WORKER_DEFAULT_POINTS : Math.min(WORKER_MAX_POINTS, Math.max(WORKER_MIN_POINTS, Math.round(n * 4) / 4)));
const cleanLabel = (s: string) => s.replace(/[\u0000-\u001f\u007f|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

/** The problems of a spec as given (by the controller main, or read back from a slip). */
type Given = { label?: unknown; branch?: unknown; base?: unknown; model?: unknown; points?: unknown; resume?: unknown };
export function specProblems(s: Given): string[] {
	const out: string[] = [];
	if (s.label !== undefined && (typeof s.label !== "string" || !cleanLabel(s.label))) out.push("label must be a non-empty string");
	if (s.resume !== undefined && (typeof s.resume !== "string" || !SESSION_ID.test(s.resume))) out.push("resume must be a worker's full session id (a lowercase uuid, as its receipt prints it)");
	if (s.resume !== undefined && s.base !== undefined) out.push("base goes with a new worker, not with resume: a resumed worker keeps its branch and worktree");
	if (typeof s.branch === "string") { const p = branchProblem(s.branch); if (p) out.push(`branch ${p}`); }
	else if (s.branch !== undefined || s.resume === undefined) out.push("branch is required"); // a resume's record names it
	if (s.base !== undefined && (typeof s.base !== "string" || !BASE.test(s.base) || s.base.includes("..") || s.base.startsWith("-"))) out.push("base must be a branch name of origin or a 40-hex commit");
	if (s.model !== undefined && (typeof s.model !== "string" || !MODEL.test(s.model))) out.push("model must be a model id (A-Z a-z 0-9 . _ : / @ -, at most 120)");
	if (s.points !== undefined && (typeof s.points !== "number" || !Number.isFinite(s.points) || s.points <= 0)) out.push("points must be a number over 0");
	return out;
}
/** The spec, checked; throws with every problem. The label defaults to the branch. */
export function workerSpec(s: Given & { resume?: undefined }): WorkerSpec;
export function workerSpec(s: Given): Slip;
export function workerSpec(s: Given): Slip {
	const p = specProblems(s);
	if (p.length) throw new Error(`sb: worker ${p.join("; ")}`);
	if (typeof s.resume === "string") return { label: typeof s.label === "string" ? cleanLabel(s.label) : `resume ${s.resume.slice(0, 8)}`, resume: s.resume, ...(typeof s.branch === "string" ? { branch: s.branch } : {}), ...(typeof s.model === "string" ? { model: s.model } : {}), ...(s.points !== undefined ? { points: clampPoints(s.points as number) } : {}) };
	const branch = s.branch as string;
	return { label: typeof s.label === "string" ? cleanLabel(s.label) : branch, branch, ...(typeof s.base === "string" ? { base: s.base } : {}), ...(typeof s.model === "string" ? { model: s.model } : {}), points: clampPoints(s.points as number | undefined) };
}
/** The slip's first line. */
export const workerLine = (s: Slip) => [`worker: ${cleanLabel(s.label)}`, ...(s.resume ? [`resume: ${s.resume}`] : []), ...(s.branch ? [`branch: ${s.branch}`] : []), ...(s.resume === undefined && s.base ? [`base: ${s.base}`] : []), ...(s.model ? [`model: ${s.model}`] : []), ...(s.points !== undefined ? [`points: ${s.points}`] : [])].join(" | ");
/** The whole message: the line, then the brief. Throws on a spec or a brief that is refused. */
export function workerMessage(s: Slip, brief: string): string {
	if (!brief.trim()) throw new Error("sb: worker needs a brief (the message)");
	if (brief.length > WORKER_BRIEF_MAX) throw new Error(`sb: a worker brief is at most ${WORKER_BRIEF_MAX} characters`);
	return `${workerLine(s)}\n${brief}`;
}
/** A message read back: its spec and brief when its first line is a worker slip; `{ error }` when the line starts `worker:` but is refused; nothing when it is no slip. */
export function parseWorker(text: string): { spec: Slip; brief: string } | { error: string } | undefined {
	const nl = text.indexOf("\n"), first = (nl < 0 ? text : text.slice(0, nl)).trim(), brief = nl < 0 ? "" : text.slice(nl + 1);
	if (!/^worker:/.test(first)) return undefined;
	const fields: Record<string, string> = {};
	for (const part of first.split("|")) {
		const m = /^\s*([a-z]+):\s*(.*?)\s*$/.exec(part);
		if (!m || !(KEYS as readonly string[]).includes(m[1]!) || m[1]! in fields) return { error: `sb: the worker line has a part that is not one of ${KEYS.join(", ")} (once each): «${part.trim().slice(0, 60)}»` };
		fields[m[1]!] = m[2]!;
	}
	const points = fields.points === undefined ? undefined : Number(fields.points);
	try {
		const spec = workerSpec({ label: fields.worker, ...(fields.resume !== undefined ? { resume: fields.resume } : {}), ...(fields.branch !== undefined ? { branch: fields.branch } : {}), ...(fields.base !== undefined ? { base: fields.base } : {}), ...(fields.model !== undefined ? { model: fields.model } : {}), ...(points !== undefined ? { points } : {}) });
		if (!brief.trim()) return { error: "sb: the worker message has no brief under its line" };
		return { spec, brief };
	} catch (error) {
		return { error: (error as Error).message };
	}
}
