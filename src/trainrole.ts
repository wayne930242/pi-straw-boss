import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HEAD_LABEL, type HerdrRun, panes, TOWER_LABEL } from "./herdr.ts";
import { appsFile } from "./train/appsconfig.ts";
import { isCode, isName, shortCode } from "./train/spec.ts";

// The role `train` in Straw Boss's own records (docs/specs/2026-11-07-train-workers.md §3.3). A train is opened by the tower on an integrator's manifest, runs in a tab of its own, and is
// known by two pane tokens: `sb_role=train` and `sb_train=<project>/<code>`. The words and the small rules of that live here, so the opener, the session and the readers agree on them.

export const TRAIN = "train";
/** What the session says on pi's event bus once it knows it is a train (`{ train: true }`): process hygiene registers the pi as an owner of its own on that word, not on the shell's role. */
export const TRAIN_EVENT = "straw-boss:train";
/** `maxTrains` of the project's apps.json (top-level `integration`) when it names none (D4). */
export const DEFAULT_MAX_TRAINS = 3;
const MAX_TRAINS_CAP = 32;

/** The roles whose sessions count as joined sessions of a workspace (the guard's and the tower's member counts): a train needs its tower like a member does. */
export const isSessionRole = (token: string | undefined): boolean => token === "member" || token === "main" || token === TRAIN;
/** The roles that write the work board: a main, and a train, whose line fills from its todos as a main's does. */
export const ownsBoard = (role: string | undefined): boolean => role === "main" || role === TRAIN;

/** The project a train works for and its code (`YYYY-MM-DD-<letters>`, spec D3). */
export interface TrainId { project: string; code: string }

/** The pane token that names a train: `<project>/<code>`. */
export const trainToken = (t: TrainId): string => `${t.project}/${t.code}`;
/** A token read back; undefined for anything that is not a project and a code. */
export function trainFromToken(token: unknown): TrainId | undefined {
	if (typeof token !== "string") return undefined;
	const at = token.lastIndexOf("/");
	if (at < 1) return undefined;
	const project = token.slice(0, at), code = token.slice(at + 1);
	return isName(project) && isCode(code) ? { project, code } : undefined;
}
/** The name of a train's tab and session, set by the open and never changed: `train 1106m`. */
export const trainLabel = (code: string): string => `train ${shortCode(code)}`;

/**
 * Whether a label is one only Straw Boss gives a tab: the tower's and the head tower's glyph, and a train's `train <MMDDx>`. Such a tab is what proves a tower or a train after a restore
 * (roles.ts), so a session's `boss_rename` and a tower's `boss_open_main` never name a tab into one.
 */
export const isRoleLabel = (label: string): boolean => label === TOWER_LABEL || label === HEAD_LABEL || /^train \d{4}[a-z]{1,2}$/.test(label);

/** The first `project:` and `code:` of the manifest the tower passes verbatim as the open's request (§5.3): `key: value` lines or JSON members, the manifest's own header first. */
export function trainFromRequest(request: string): TrainId | { refusal: string } {
	const find = (key: string) => new RegExp(`(?:^|[{,])[ \\t>*-]*["']?${key}["']?[ \\t]*[:=][ \\t]*["']?([^\\s"',}]+)`, "im").exec(request)?.[1];
	const [project, code] = [find("project"), find("code")];
	if (!project || !code) return { refusal: `A train is opened on its manifest: the request must carry "project: <name>" and "code: <YYYY-MM-DD-letters>" (missing ${[!project && "project", !code && "code"].filter(Boolean).join(" and ")})` };
	if (!isName(project)) return { refusal: `The manifest's project "${String(project).slice(0, 80)}" is not a path-safe name` };
	if (!isCode(code)) return { refusal: `The manifest's code "${String(code).slice(0, 80)}" is not a train code (YYYY-MM-DD-<one or two lowercase letters>)` };
	return { project, code };
}

/** The manifest header's `app:` line, if it has one (the same line the train's manifest check reads). */
export const appFromRequest = (request: string): string | undefined => /^\s*app:\s*([A-Za-z0-9._-]{1,64})\s*$/m.exec(request.split(/\r?\n(?=\s*(?:car:|app:[^|\n]*\|\s*(?:car|tickets):))/i)[0] ?? request)?.[1];

/** `integration.maxTrains` as apps.json gives it: absent is the default; anything but a whole number from 1 to 32 is a refusal naming the field. */
export function maxTrainsOf(value: unknown): number | { refusal: string } {
	if (value === undefined) return DEFAULT_MAX_TRAINS;
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_TRAINS_CAP ? value : { refusal: `apps.json: integration.maxTrains must be a whole number from 1 to ${MAX_TRAINS_CAP}, not ${JSON.stringify(value)?.slice(0, 40)}` };
}
/** `maxTrains` of the project in `dir` (`.straw-boss/apps.json`): the default when the file is not there; a file that cannot be read or does not say it right is a refusal, not a guess. */
export function readMaxTrains(dir: string): number | { refusal: string } {
	const { file } = appsFile(dir);
	let text: string;
	try { text = readFileSync(file, "utf8"); } catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? DEFAULT_MAX_TRAINS : { refusal: `${file} cannot be read (${(error as Error).message}), so maxTrains is unknown` };
	}
	let config: unknown;
	try { config = JSON.parse(text.replace(/^\uFEFF/, "")); } catch (error) { return { refusal: `${file} cannot be parsed (${(error as Error).message}), so maxTrains is unknown` }; }
	const integration = typeof config === "object" && config !== null && !Array.isArray(config) ? (config as Record<string, unknown>).integration : undefined;
	if (integration === undefined) return DEFAULT_MAX_TRAINS;
	if (typeof integration !== "object" || integration === null || Array.isArray(integration)) return { refusal: `${file}: integration must be an object` };
	return maxTrainsOf((integration as Record<string, unknown>).maxTrains);
}

/** The live train of a tab, from its pane's tokens (`sb_role=train`, `sb_train`): the pi that runs in it, if any. A pane list that cannot be had is no answer, and throws. */
export async function trainInTab(run: HerdrRun, workspaceId: string, tabId: string): Promise<TrainId | undefined> {
	for (const p of await panes(run, workspaceId)) {
		if (p.tab_id !== tabId || p.tokens?.sb_role !== TRAIN) continue;
		const id = trainFromToken(p.tokens.sb_train);
		if (id) return id;
	}
	return undefined;
}
