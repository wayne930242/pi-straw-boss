// The contract of a train's step (docs/specs/2026-11-07-train-workers.md §6, §7.1): every todo of a train carries one `metadata.sb` object, a step, whose kind only classifies (D7) and whose
// check says how it passes. Pure: nothing here reads a file, a clock, or a process, and every refusal is a string in the words the guard hands the model, so the guard (task 4), the CLI (`train check`, task 2)
// and the page read one validator. A train runs no acceptance (D11, D13): it is refused here, in the kind, the name, and the check type, with `acceptanceWord`.

export const KINDS = ["assemble", "review", "full-check", "merge", "ci", "deploy", "deploy-verify", "rollback", "land"] as const;
export type Kind = (typeof KINDS)[number];
export const CHECK_TYPES = ["run", "git", "report", "notice"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];
export const MAX_SB_BYTES = 8 * 1024;
/** The most tickets one car carries and the longest ticket: the car's identity, so every place that keeps a car's tickets keeps them whole up to this bound, and a slip over it is refused (the sender splits the car). */
export const MAX_CAR_TICKETS = 64, MAX_TICKET_CHARS = 64;

export const SHA_RE = /^[0-9a-f]{40}$/;
export const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const CODE_RE = /^(\d{4})-(\d{2})-(\d{2})-([a-z]{1,2})$/;
/** A folder name that reads as a code with any number of letters: the trainboard lists such a folder (and shows it unreadable) rather than hiding a train that was named wrongly. */
export const FOLDER_CODE_RE = /^(\d{4})-(\d{2})-(\d{2})-([a-z]+)$/;
/** A path-safe name: the characters of NAME_RE, and not made only of dots, so it never climbs out of the folder it names. */
export const isName = (value: unknown): value is string => typeof value === "string" && NAME_RE.test(value) && !/^\.+$/.test(value);
const LOCK_RE = /^[a-z0-9-]{1,32}$/;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export type Json = Record<string, unknown>;
export const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const present = (value: unknown) => value !== undefined;
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.trim() !== "" && value.length <= max;
const isWhole = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
export const kb = (bytes: number) => (bytes / 1024).toFixed(1);

export const MAX_DEPTH = 32;
const MAX_NODES = 200_000;

/** Whether a value nests deeper than `limit` levels (a cycle always does) or holds an absurd number of nodes, found without recursion so no input can overflow the stack; JSON.stringify, which does recurse, comes only after this says no. */
export function tooDeep(value: unknown, limit = MAX_DEPTH): boolean {
	const stack: [unknown, number][] = [[value, 0]];
	let nodes = 0;
	while (stack.length) {
		const [node, depth] = stack.pop()!;
		if (typeof node !== "object" || node === null) continue;
		if (depth >= limit || ++nodes > MAX_NODES) return true;
		for (const child of Array.isArray(node) ? node : Object.values(node)) stack.push([child, depth + 1]);
	}
	return false;
}

/** The bytes of a value as JSON, or a refusal in the words of `what`: too nested (never walked), not JSON (a BigInt, a throwing toJSON), or larger than `max`. */
export function jsonBytes(value: unknown, what: string, max: number): { bytes: number; refusal?: undefined } | { refusal: string; bytes?: undefined } {
	if (tooDeep(value)) return { refusal: `sb: ${what} is nested more than ${MAX_DEPTH} levels` };
	let bytes: number;
	try {
		bytes = Buffer.byteLength(JSON.stringify(value) ?? "");
	} catch (error) {
		return { refusal: `sb: ${what} is not JSON (${(error as Error).message})` };
	}
	return bytes > max ? { refusal: `sb: ${what} is ${kb(bytes)} KB, more than ${max / 1024}` } : { bytes };
}

const realDate = (y: number, m: number, d: number) => {
	const date = new Date(Date.UTC(y, m - 1, d));
	return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

/** An ISO 8601 time with its zone (`Z` or `±hh:mm`): a time without one is not a time, since the files that carry it are read on other computers. */
export function isoTime(value: unknown): value is string {
	const m = typeof value === "string" ? ISO_RE.exec(value) : null;
	if (!m) return false;
	const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0)) as [number, number, number, number, number, number];
	return realDate(y, mo, d) && h < 24 && mi < 60 && s < 60 && (m[8] === undefined || (Number(m[8]) < 24 && Number(m[9]) < 60));
}

/** A train code, `YYYY-MM-DD-<letters>` with a real date and one or two lowercase letters (D3). */
export const isCode = (value: unknown): value is string => {
	const m = typeof value === "string" ? CODE_RE.exec(value) : null;
	return !!m && realDate(Number(m[1]), Number(m[2]), Number(m[3]));
};

/** The short code the people read, `MMDDx`: `2026-11-06-m` is `1106m`. */
export function shortCode(code: string): string {
	const m = isCode(code) ? CODE_RE.exec(code)! : null;
	if (!m) throw new Error(`sb: "${code}" is not a train code (YYYY-MM-DD-<letters>)`);
	return `${m[2]}${m[3]}${m[4]}`;
}

/** Departure order of two codes: by day, then by letters, one letter before two (`z` before `aa`), so a later train never sorts before an earlier one. */
export function compareCodes(a: string, b: string): number {
	const x = FOLDER_CODE_RE.exec(a), y = FOLDER_CODE_RE.exec(b);
	if (!x || !y) return a < b ? -1 : a > b ? 1 : 0;
	const day = `${x[1]}-${x[2]}-${x[3]}`, other = `${y[1]}-${y[2]}-${y[3]}`;
	if (day !== other) return day < other ? -1 : 1;
	return x[4]!.length - y[4]!.length || (x[4]! < y[4]! ? -1 : x[4]! > y[4]! ? 1 : 0);
}

// ---- acceptance is no train's (D13, §5.4)

/** The one word every refusal of a request for acceptance uses: what was asked and where, and that the criteria go back to their coordinator. */
export const acceptanceWord = ({ car, what, where }: { car?: string; what: string; where: string }) =>
	`sb: the train runs no acceptance: ${car === undefined ? "a step" : `car ${car}`} asks for ${what} (${where}); rewrite its acceptance criteria and run them before loading, then send the evidence in accept:`;

// One rule for "does this text ask for acceptance", used by the step's kind, name and check type, by the slip's free text and by the evidence's free text (§5.4, §18): the text is folded (NFKD, marks and format characters
// stripped, a few Cyrillic and Greek look-alikes mapped to Latin), cut into words at non-alphanumerics, camelCase and letter or digit boundaries, and read in lower case. A refusal costs only a rewrite, so the rule leans to refusing.
const LOOKALIKES: Record<string, string> = { а: "a", А: "A", е: "e", Е: "E", с: "c", С: "C", р: "p", Р: "P", т: "t", Т: "T", о: "o", О: "O", х: "x", Х: "X", у: "y", α: "a", Α: "A", ε: "e", Ε: "E", ο: "o", Ο: "O", ρ: "p", Ρ: "P", τ: "t", Τ: "T", υ: "u", Υ: "Y", ս: "u" };
const INVISIBLE = /[\p{M}\p{Cf}]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

/** The text as it is read: compatibility-decomposed, without marks, format or control characters, look-alike letters made Latin. Case is kept (camelCase needs it). */
export const foldText = (text: string): string => text.normalize("NFKD").replace(INVISIBLE, "").replace(/[^\u0000-\u007f]/g, (c) => LOOKALIKES[c] ?? c);

/** The words of a text in each reading of its capitals (and with none read as a boundary): `UATpage` is `uat page` where an all-caps run stands whole and `ua tpage` where its last capital leads the next word; digits split off in the second pair of readings. */
function wordLists(text: string): string[][] {
	const folded = foldText(text);
	const std = folded.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
	const whole = folded.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)(?=[a-z])/g, "$1 ").replace(/([a-z])([A-Z])/g, "$1 $2");
	// The unsplit reading as well: a capital inside a word (`UaT`) is no boundary, and case is ignored.
	const out: string[][] = [folded.toLowerCase().match(/[a-z0-9]+/g) ?? []];
	for (const reading of [std, whole]) for (const digits of [false, true]) {
		const spaced = digits ? reading.replace(/([A-Za-z])(\d)/g, "$1 $2").replace(/(\d)([A-Za-z])/g, "$1 $2") : reading;
		out.push((spaced.toLowerCase().match(/[a-z0-9]+/g) ?? []));
	}
	return out;
}

/** The text as lower-case words separated by single spaces, camelCase split and punctuation gone, other scripts kept: the string the phrases of a request (`after deploy`, 部署後) are looked for in. */
export const spokenText = (text: string): string => foldText(text).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const ACCEPT_WORD = /^accept(?:s|ed|ing|ance|ances)?$/;
const HAN_ACCEPT = /驗收|验收/;

/** The acceptance word in a text, if it holds one: `uat`, `e2e`, `accept` (and `accepts`, `accepted`, `acceptance`, not `acceptable`), `end-to-end`, or 驗收 anywhere, in any case, width, camelCase or spacing: `runE2E`, `UATpage`, `ＵＡＴ`, `U\u200bAT`. Not `evaluate` or `equation`, which only contain `uat`. */
export function acceptanceToken(text: unknown): string | undefined {
	if (typeof text !== "string") return undefined;
	const han = HAN_ACCEPT.exec(foldText(text))?.[0];
	if (han) return han;
	for (const words of wordLists(text)) {
		for (let i = 0; i < words.length; i++) {
			const w = words[i]!;
			if (w === "uat" || w === "e2e" || ACCEPT_WORD.test(w)) return w;
			if (w === "endtoend") return "end-to-end";
			if (w === "end" && words[i + 1] === "to" && words[i + 2] === "end") return "end-to-end";
			if (w === "e" && words[i + 1] === "2" && words[i + 2] === "e") return "e2e";
		}
	}
	return undefined;
}

// ---- the step

const MAX_RUN = 4096, MAX_PATH = 1024;
const KIND_LIST = KINDS.join(", ");
export const STEP_REQUIRED = `sb: every todo of a train is a step: add metadata.sb (kinds: ${KIND_LIST})`;
const NAME_HELP = "a path-safe name (letters, digits, ., _, -; 1 to 64 characters)";
const FIELDS = ["v", "project", "app", "train", "round", "kind", "name", "spec", "result"];
const SPEC_FIELDS = ["check", "on", "load", "lock", "holds", "cars", "removed"];
const CHECK_FIELDS: Record<CheckType, string[]> = {
	run: ["type", "cwd", "run", "log", "verify", "expect", "poll"],
	git: ["type", "cwd", "contains", "ref"],
	report: ["type", "path", "expect"],
	notice: ["type", "cars", "state"],
};
const RESULT_FIELDS = ["outcome", "why", "evidence", "at", "head", "verdict"];

export interface Here { project: string; app: string; train: string; round: number }
export interface StepOptions {
	/** The todo's status once the call is applied: a result is set (and required) only on `completed`; left out, the result is only checked for its shape. */
	status?: string;
	/** The todo's id, for the words of a refusal. */
	id?: number;
	/** This train's identity and current round. */
	expect?: Here;
}

const unknownKeys = (value: Json, allowed: string[], path: string) => Object.keys(value).filter((key) => present(value[key]) && !allowed.includes(key)).map((key) => `sb: ${path}.${key} is not a field`);

function checkRefusals(check: Json): string[] {
	const type = check.type;
	const out: string[] = [];
	if (typeof type !== "string" || !(CHECK_TYPES as readonly string[]).includes(type)) return [`sb: check type "${typeof type === "string" ? type : ""}" is not one a train runs (${CHECK_TYPES.join(", ")})`];
	const kind = type as CheckType, at = "metadata.sb.spec.check";
	const needs = (field: string, ok: boolean) => ok || (out.push(`sb: a ${kind} check needs ${field}`), false);
	out.push(...unknownKeys(check, CHECK_FIELDS[kind], at));
	if (kind === "run") {
		needs("cwd", isText(check.cwd, MAX_PATH)), needs("run", isText(check.run, MAX_RUN)), needs("log", isText(check.log, MAX_PATH));
		if (present(check.verify) && !isText(check.verify, MAX_RUN)) out.push("sb: a run check's verify must be a string");
		if (present(check.expect) && typeof check.expect !== "string") out.push("sb: a run check's expect must be a string");
		if (present(check.expect) && !present(check.verify)) out.push("sb: a run check's expect needs verify");
		if (present(check.poll)) {
			const poll = check.poll;
			if (!present(check.expect)) out.push("sb: a run check's poll needs expect");
			if (!isObject(poll)) out.push(`sb: ${at}.poll must be an object`);
			else {
				out.push(...unknownKeys(poll, ["everySec", "forMin"], `${at}.poll`));
				if (!isWhole(poll.everySec, 1, 3600)) out.push(`sb: ${at}.poll.everySec must be a whole number from 1 to 3600`);
				if (!(typeof poll.forMin === "number" && poll.forMin > 0 && poll.forMin <= 1440)) out.push(`sb: ${at}.poll.forMin must be a number above 0, at most 1440`);
			}
		}
	} else if (kind === "git") {
		needs("cwd", isText(check.cwd, MAX_PATH));
		if (needs("contains", Array.isArray(check.contains) && check.contains.length > 0)) {
			(check.contains as unknown[]).forEach((sha, i) => SHA_RE.test(String(sha)) || out.push(`sb: ${at}.contains[${i}] must be 40 hex`));
			if ((check.contains as unknown[]).length > 64) out.push(`sb: ${at}.contains has more than 64 commits`);
		}
		if (present(check.ref) && !isText(check.ref, 255)) out.push(`sb: ${at}.ref must be a non-empty string`);
	} else if (kind === "report") {
		needs("path", isText(check.path, MAX_PATH)), needs("expect", isText(check.expect, 200));
	} else {
		if (needs("cars", Array.isArray(check.cars) && check.cars.length > 0)) {
			(check.cars as unknown[]).forEach((car, i) => isText(car, 64) && !/\s/.test(car) || out.push(`sb: ${at}.cars[${i}] must be a ticket without spaces`));
			if ((check.cars as unknown[]).length > 32) out.push(`sb: ${at}.cars has more than 32 tickets`);
		}
		if (needs("state", present(check.state))) ["landed", "returned", "dropped"].includes(check.state as string) || out.push("sb: a notice check's state must be landed, returned or dropped");
	}
	return out;
}

function onRefusals(on: unknown): string[] {
	const at = "metadata.sb.spec.on";
	if (!isObject(on)) return [`sb: ${at} must be an object`];
	const out = unknownKeys(on, ["head", "target", "version"], at);
	const head = present(on.head), target = present(on.target) || present(on.version);
	if (head && target) out.push(`sb: ${at} takes head, or target and version, not both`);
	else if (head) SHA_RE.test(String(on.head)) || out.push(`sb: ${at}.head must be 40 hex`);
	else if (target) {
		if (!isText(on.target, 128)) out.push(`sb: ${at}.target must be a non-empty string`);
		if (!isText(on.version, 128)) out.push(`sb: ${at}.version is required with target`);
	} else out.push(`sb: ${at} needs head, or target and version`);
	return out;
}

function loadRefusals(load: unknown): string[] {
	const at = "metadata.sb.spec.load";
	if (!isObject(load)) return [`sb: ${at} must be an object`];
	const out = unknownKeys(load, ["max", "perCore", "weight"], at);
	const max = present(load.max), perCore = present(load.perCore);
	if (max && perCore) out.push(`sb: ${at} takes max or perCore, not both`);
	else if (!max && !perCore) out.push(`sb: ${at} needs max or perCore`);
	for (const key of ["max", "perCore"]) if (present(load[key]) && !(typeof load[key] === "number" && (load[key] as number) > 0 && (load[key] as number) <= 10000)) out.push(`sb: ${at}.${key} must be a number above 0`);
	if (present(load.weight) && !(typeof load.weight === "number" && load.weight > 0 && load.weight <= 1024)) out.push(`sb: ${at}.weight must be a number above 0, at most 1024`);
	return out;
}

function holdsRefusals(holds: unknown): string[] {
	const at = "metadata.sb.spec.holds";
	if (!isObject(holds)) return [`sb: ${at} must be an object`];
	const out = unknownKeys(holds, ["lane", "target"], at);
	if (!present(holds.lane) && !present(holds.target)) out.push(`sb: ${at} needs lane or target`);
	for (const key of ["lane", "target"]) if (present(holds[key]) && !(isName(holds[key]))) out.push(`sb: ${at}.${key} must be ${NAME_HELP}`);
	return out;
}

/** An assemble step's cars (the tickets kept) and removed (the cars it leaves out, why, and the evidence): §3.5 and §5.5. No other kind takes them. */
function carsRefusals(spec: Json, kind: unknown): string[] {
	const at = "metadata.sb.spec", out: string[] = [];
	if (kind !== "assemble") out.push("sb: only an assemble step takes cars and removed");
	const ticket = (value: unknown) => isText(value, 64) && !/\s/.test(value);
	if (present(spec.cars)) {
		if (!Array.isArray(spec.cars) || spec.cars.length > 32) out.push(`sb: ${at}.cars must be a list of at most 32 tickets`);
		else spec.cars.forEach((car, i) => ticket(car) || out.push(`sb: ${at}.cars[${i}] must be a ticket without spaces`));
	}
	if (present(spec.removed)) {
		if (!Array.isArray(spec.removed) || spec.removed.length > 32) out.push(`sb: ${at}.removed must be a list of at most 32 cars`);
		else spec.removed.forEach((car, i) => {
			if (!isObject(car)) return void out.push(`sb: ${at}.removed[${i}] must be an object`);
			out.push(...unknownKeys(car, ["ticket", "why", "evidence"], `${at}.removed[${i}]`));
			if (!ticket(car.ticket)) out.push(`sb: ${at}.removed[${i}].ticket must be a ticket without spaces`);
			if (!isText(car.why, 600)) out.push(`sb: ${at}.removed[${i}].why must be 1 to 600 characters`);
			if (present(car.evidence) && !isText(car.evidence, MAX_PATH)) out.push(`sb: ${at}.removed[${i}].evidence must be a non-empty string`);
		});
	}
	return out;
}

function resultRefusals(sb: Json, result: unknown, check: Json | undefined): string[] {
	const at = "metadata.sb.result";
	if (!isObject(result)) return [`sb: ${at} must be an object`];
	const out = unknownKeys(result, RESULT_FIELDS, at);
	const outcome = result.outcome;
	if (!["passed", "failed", "void"].includes(outcome as string)) out.push(`sb: ${at}.outcome must be passed, failed or void`);
	if (outcome === "void") ["superseded", "skipped"].includes(result.why as string) || out.push(`sb: ${at}.why must be superseded or skipped`);
	else if (present(result.why)) out.push(`sb: ${at}.why belongs to a void outcome`);
	if (!isText(result.evidence, 500)) out.push(`sb: ${at}.evidence must be 1 to 500 characters`);
	if (!isoTime(result.at)) out.push(`sb: ${at}.at must be an ISO time with its zone`);
	if (present(result.head) && !SHA_RE.test(String(result.head))) out.push(`sb: ${at}.head must be 40 hex`);
	if (present(result.verdict) && !isText(result.verdict, 200)) out.push(`sb: ${at}.verdict must be a non-empty string`);
	if (outcome === "passed" && check) {
		const spec = isObject(sb.spec) ? sb.spec : {}, on = isObject(spec.on) ? spec.on : {};
		if (check.type === "git") {
			if (!SHA_RE.test(String(result.head))) out.push("sb: a git check passes with result.head, the commit HEAD showed");
			else if (on.head !== result.head) out.push("sb: on.head must equal result.head for a git check to pass");
		} else if (check.type === "report") {
			if (!present(result.verdict)) out.push("sb: a report check passes with result.verdict, the report's verdict line");
			else if (result.verdict !== check.expect) out.push(`sb: result.verdict must equal the check's expect (${String(check.expect)})`);
		}
	}
	return out;
}

/** What a step's `metadata.sb` is refused for, in the guard's words; an empty list means it is well formed. The kind decides nothing but its own membership of the set (D7). */
export function validateStep(value: unknown, opts: StepOptions = {}): string[] {
	if (!isObject(value)) return ["sb: metadata.sb must be an object"];
	const spec = isObject(value.spec) ? value.spec : undefined, check = spec && isObject(spec.check) ? spec.check : undefined;
	// A request for acceptance comes first and alone: the call is refused at once, whatever else is wrong with it.
	for (const [text, where] of [[value.kind, "step kind"], [value.name, "step name"], [check?.type, "check type"]] as const) {
		const token = acceptanceToken(text);
		if (token !== undefined) return [acceptanceWord({ what: String(text), where })];
	}
	const size = jsonBytes(value, "metadata.sb", MAX_SB_BYTES);
	if (size.refusal) return [size.refusal];
	const out = unknownKeys(value, FIELDS, "metadata.sb");
	if (value.v !== 1) out.push("sb: metadata.sb.v must be 1");
	for (const key of ["project", "app"] as const) if (!(typeof value[key] === "string" && isName(value[key]))) out.push(`sb: metadata.sb.${key} must be ${NAME_HELP}`);
	if (!isCode(value.train)) out.push("sb: metadata.sb.train must be YYYY-MM-DD-<letters> (a real date, one or two lowercase letters)");
	if (!isWhole(value.round, 1)) out.push("sb: metadata.sb.round must be a whole number from 1");
	if (!present(value.kind)) out.push(`sb: metadata.sb.kind is required (kinds: ${KIND_LIST})`);
	else if (!(KINDS as readonly string[]).includes(value.kind as string)) out.push(`sb: kind "${String(value.kind)}" is not a step kind (${KIND_LIST})`);
	if (!(typeof value.name === "string" && value.name.trim() !== "" && value.name.length <= 64 && !CONTROL.test(value.name))) out.push("sb: metadata.sb.name must be 1 to 64 characters without control characters");
	if (!spec) out.push("sb: metadata.sb.spec must be an object");
	else {
		out.push(...unknownKeys(spec, SPEC_FIELDS, "metadata.sb.spec"));
		if (!present(spec.check)) out.push("sb: metadata.sb.spec needs check");
		else if (!check) out.push("sb: metadata.sb.spec.check must be an object");
		else out.push(...checkRefusals(check));
		const type = check?.type;
		if (present(spec.on)) out.push(...onRefusals(spec.on));
		else if (type !== "notice") out.push("sb: metadata.sb.spec.on is required for every check but notice");
		if (present(spec.load)) type !== "run" ? out.push("sb: only a run check takes load") : out.push(...loadRefusals(spec.load));
		if (present(spec.lock)) {
			if (type !== "run") out.push("sb: only a run check takes lock");
			else if (!(typeof spec.lock === "string" && LOCK_RE.test(spec.lock))) out.push("sb: metadata.sb.spec.lock must be 1 to 32 of a-z, 0-9, -");
		}
		if (present(spec.holds)) out.push(...holdsRefusals(spec.holds));
		if (present(spec.cars) || present(spec.removed)) out.push(...carsRefusals(spec, value.kind));
	}
	if (opts.status !== undefined) {
		if (opts.status === "completed" && !present(value.result)) out.push("sb: completed needs a result in metadata.sb.result");
		else if (opts.status !== "completed" && present(value.result)) out.push("sb: metadata.sb.result is set only on completed");
	}
	if (present(value.result)) out.push(...resultRefusals(value, value.result, check));
	if (opts.expect) {
		const here = opts.expect, id = `step #${opts.id ?? "?"}`;
		if (value.train !== here.train || value.round !== here.round) out.push(`sb: ${id} names train ${String(value.train)}, round ${String(value.round)}; this train is ${here.train}, round ${here.round}`);
		if (value.project !== here.project) out.push(`sb: ${id} names project ${String(value.project)}; this train's is ${here.project}`);
		if (value.app !== here.app) out.push(`sb: ${id} names app ${String(value.app)}; this train's is ${here.app}`);
	}
	return out;
}

// ---- a todo call, applied to a copy

export type Metadata = Record<string, unknown>;
export interface TodoRow { id: number; status: string; metadata?: Metadata }
/** `item` is the index in a batch create's `tasks`, which a non-object item before it does not shift. */
export interface Effect { id: number; created: boolean; status: string; metadata?: Metadata; item?: number }

/** rpiv-todo's merge of an update's metadata: top-level keys are replaced whole, a `null` deletes one, and an empty result is no metadata. */
export function mergeMetadata(current: Metadata | undefined, patch: Metadata | undefined): Metadata | undefined {
	if (patch === undefined) return current && { ...current };
	const merged: Metadata = { ...(current ?? {}) };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete merged[key];
		else merged[key] = value;
	}
	return Object.keys(merged).length ? merged : undefined;
}

/** What a `todo` call leaves in each todo it creates or updates, applied the way rpiv-todo applies it: only the merged snapshot shows what an update did (spike (a)). Reads, deletes, and an update of an unknown id (rpiv-todo's own error) have no effect. */
export function todoEffects(input: unknown, current: readonly TodoRow[], nextId = Math.max(0, ...current.map((t) => t.id)) + 1): Effect[] {
	if (!isObject(input)) return [];
	const meta = (value: unknown) => (isObject(value) ? { ...value } : undefined);
	if (input.action === "create") {
		const items = Array.isArray(input.tasks) ? input.tasks : [input];
		return items.flatMap((item, index) => (isObject(item) ? [{ item: index, metadata: meta(item.metadata) }] : [])).map(({ item, metadata }, i): Effect => ({ id: nextId + i, created: true, status: "pending", metadata, ...(Array.isArray(input.tasks) ? { item } : {}) }));
	}
	if (input.action === "update" && typeof input.id === "number") {
		const task = current.find((t) => t.id === input.id);
		if (!task) return [];
		return [{ id: task.id, created: false, status: typeof input.status === "string" ? input.status : task.status, metadata: mergeMetadata(task.metadata, isObject(input.metadata) ? input.metadata : undefined) }];
	}
	return [];
}

/** The refusals of a `todo` call in a train: every todo it creates or updates must be a step (D8), and a valid one. A batch names the item (`tasks[1]`). */
export function checkTodoCall(input: unknown, current: readonly TodoRow[], here: Here, nextId?: number): string[] {
	const batch = isObject(input) && input.action === "create" && Array.isArray(input.tasks);
	return todoEffects(input, current, nextId).flatMap((effect) => {
		if (effect.status === "deleted") return [];
		const sb = effect.metadata?.sb;
		const refusals = sb === undefined ? [STEP_REQUIRED] : validateStep(sb, { status: effect.status, id: effect.id, expect: here });
		return batch ? refusals.map((r) => r.replace(/^sb: /, `sb: tasks[${effect.item}]: `)) : refusals;
	});
}

// ---- the parts every later reader shares

export interface Holds { lane?: string; target?: string }
export interface LoadSpec { max?: number; perCore?: number; weight?: number }
