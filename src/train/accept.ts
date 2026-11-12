import { acceptanceToken, acceptanceWord, isObject, isoTime, isName, kb, MAX_CAR_TICKETS, MAX_TICKET_CHARS, SHA_RE, spokenText } from "./spec.ts";

// What a coordinator hands the train and what `train check --accept` proves about it (docs/specs/2026-11-07-train-workers.md §5.1 to §5.4): the slip's `departs` and `accept` lines, the acceptance evidence file, and
// `integration.accept` and `stages` of apps.json. Acceptance happens before loading (D11), so a slip or evidence that asks the train for any is refused at once with `acceptanceWord` (D13). Pure: the files and git come in as functions.
// The check proves the evidence is complete, names the car's head, and points at files that exist; it does not prove the boss said the quoted nod (§16).

export { acceptanceWord };
export const MAX_EVIDENCE_BYTES = 32 * 1024;
const KINDS = ["e2e", "uat", "other"];
const ENTRY_FIELDS = ["kind", "label", "what", "on", "result", "evidence", "at", "nod", "delta"];
/** Fields of an entry that name something still to be run: a request, not evidence. */
const TO_DO = ["check", "run", "page", "checkpoints"];
const PENDING = /^(pending|todo|tbd|waiting|open|not[ _-]?run)$/i;
const ON_FIELDS = ["head"];
const present = (value: unknown) => value !== undefined;
const text = (value: unknown, max = 1000): value is string => typeof value === "string" && value.trim() !== "" && value.length <= max;

// ---- the slip

/**
 * The keys of a slip (the receive-car playbook's block); any other key refuses the slip. `car:` names the car's app (its `name` in apps.json), never a ticket: the tickets go in `tickets:`, and the first of them is what `train_car`'s
 * `car` names. `app:` is the same field under its plain name (0.77.3); a slip may give either, or both when they agree.
 */
export const SLIP_KEYS = ["car", "app", "tickets", "branch", "head", "tested-on", "review", "light", "migrations", "lane", "deploy", "departs", "accept", "uat", "auth", "coordinator"];
/** One `key: value` of a slip, in the order written; a segment with no key has `key` empty. Every entry is read for a request, including a repeated key and a keyless line. */
export interface SlipEntry { key: string; value: string; line: number }
export interface ParsedSlip { fields: Record<string, string>; tickets: string[]; entries: SlipEntry[]; problems: string[] }

/** Splits at ` | ` outside double quotes and parentheses, so a quoted `auth` or a parenthesised `light` keeps its pipes; says when a quote or a parenthesis is left open at the end of the line. */
function segments(line: string): { parts: string[]; open?: "quote" | "parenthesis" } {
	const parts: string[] = [];
	let depth = 0, quoted = false, from = 0;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '"') quoted = !quoted;
		else if (!quoted && c === "(") depth++;
		else if (!quoted && c === ")") depth = Math.max(0, depth - 1);
		else if (!quoted && depth === 0 && c === "|" && line[i - 1] === " " && line[i + 1] === " ") parts.push(line.slice(from, i - 1)), (from = i + 2);
	}
	parts.push(line.slice(from));
	return { parts, ...(quoted ? { open: "quote" as const } : depth > 0 ? { open: "parenthesis" as const } : {}) };
}

const shown = (text: string) => JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text);

/**
 * The slip's block: lines of `key: value` segments joined by ` | `. The parse fails closed (D13): the first of a repeated key is the field, but every segment is kept in `entries` to be read, and a repeated key, a key that is not
 * a slip's, a segment with no key, and a quote or parenthesis left open (which would fold the rest of the line into one field) each leave a refusal in `problems`.
 */
export function parseSlip(slip: string): ParsedSlip {
	const fields: Record<string, string> = {}, entries: SlipEntry[] = [], problems: string[] = [];
	slip.split(/\r?\n/).forEach((line, index) => {
		if (line.trim() === "") return;
		const at = `sb: slip line ${index + 1}:`, { parts, open } = segments(line);
		if (open) problems.push(`${at} unbalanced ${open === "quote" ? 'quote (")' : "parenthesis"}: the rest of the line cannot be told apart from its field`);
		for (const part of parts) {
			if (part.trim() === "") continue;
			const m = /^\s*([A-Za-z][A-Za-z0-9-]*):[ \t]*([^]*)$/.exec(part);
			if (!m) {
				entries.push({ key: "", value: part.trim(), line: index + 1 });
				problems.push(`${at} ${shown(part.trim())} has no key (key: value | key: value)`);
				continue;
			}
			const key = m[1]!.toLowerCase(), value = m[2]!.trim();
			entries.push({ key, value, line: index + 1 });
			if (!SLIP_KEYS.includes(key)) problems.push(`${at} ${key} is not a slip field (${SLIP_KEYS.join(", ")})`);
			if (key in fields) problems.push(`${at} ${key} twice`);
			else fields[key] = value;
		}
	});
	// `app:` is `car:` under its plain name: one names the other's value, and two that differ are refused, since the slip would name two apps (a ticket written in `car:` is the usual cause).
	if (fields.app !== undefined) {
		if (fields.car === undefined) fields.car = fields.app;
		else if (fields.car !== fields.app) problems.push(`sb: slip: app: ${shown(fields.app)} and car: ${shown(fields.car)} name two apps: car: names the car's app (app: is the same field), and its tickets go in tickets:`);
	}
	const tickets = (fields.tickets ?? "").replace(/\([^)]*\)/g, " ").split(/[\s,]+/).filter(Boolean);
	return { fields, tickets, entries, problems };
}

/** A line that starts a slip block: one that starts with `car:`, or with `app:` and goes on to a `car:` or `tickets:` segment (a manifest's header `app: <name>` line stands alone, and starts none). */
const SLIP_START = /^\s*(?:car:|app:[^|\n]*\|\s*(?:car|tickets):)/i;
/** Whether `line` starts a slip block. */
export const startsSlip = (line: string) => SLIP_START.test(line);

/** A text with each slip on a line of its own: a `car: <app> | tickets: …` (or `app: <app> | car:`/`tickets:`) that follows other words on its line starts a new line; one that follows a ` | ` is a segment of the slip before it. */
export const slipLines = (body: string) => body.replace(/([^\s|])[ \t]+((?:car|app):[ \t]*[A-Za-z0-9._-]+[ \t]*\|[ \t]*(?:tickets|car):)/gi, "$1\n$2");

/** A slip block starts at a `car:` line (or an `app:` slip line, `startsSlip`) and runs over the lines of `key: value | key: value` segments up to a blank line or the next `car:` line; what comes before the first block is the manifest's header. */
export function slipBlocks(text: string): { header: string; blocks: string[] } {
	const header: string[] = [], blocks: string[][] = [];
	let open = false;
	for (const line of text.split(/\r?\n/)) {
		if (startsSlip(line)) (blocks.push([line]), (open = true));
		else if (open && line.trim() !== "" && /^\s*[A-Za-z][A-Za-z0-9-]*:/.test(line)) blocks.at(-1)!.push(line);
		else {
			open = false;
			if (!blocks.length) header.push(line);
		}
	}
	return { header: header.join("\n"), blocks: blocks.map((b) => b.join("\n")) };
}

export interface Departs { mode: "next" | "alone" | "with"; with?: string; after?: string; by?: string }
export type DepartsResult = { ok: true; departs: Departs } | { ok: false; refusal: string };

/** The `departs:` line, comma separated: one ride (`next`, `alone`, `with <ticket or branch>`) and optionally `after` and `by` an ISO time. No line means `next`. */
export function parseDeparts(value: string | undefined): DepartsResult {
	const refuse = (what: string): DepartsResult => ({ ok: false, refusal: `sb: departs: ${what}` });
	const departs: Departs = { mode: "next" };
	let ride = false;
	for (const item of (value ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
		const word = item.toLowerCase();
		if (word === "next" || word === "alone" || /^with(\s|$)/.test(word)) {
			if (ride) return refuse("choose one of next, alone or with");
			ride = true;
			if (word === "with" || /^with\s*$/.test(word)) return refuse('"with" needs a ticket or branch');
			if (/^with\s/.test(word)) Object.assign(departs, { mode: "with", with: item.replace(/^with\s+/i, "") });
			else departs.mode = word as "next" | "alone";
			continue;
		}
		const time = /^(after|by)(?:\s+(.*))?$/i.exec(item);
		if (!time) return refuse(`"${item}" is not one of next, alone, with <ticket or branch>, after <ISO time>, by <ISO time>`);
		const key = time[1]!.toLowerCase() as "after" | "by";
		if (!isoTime(time[2])) return refuse(`${key} needs an ISO time with its zone, such as 2026-11-07T09:00:00Z`);
		if (departs[key]) return refuse(`${key} twice`);
		departs[key] = time[2]!;
	}
	if (departs.after && departs.by && Date.parse(departs.after) > Date.parse(departs.by)) return refuse("after is later than by");
	return { ok: true, departs };
}

/** `accept: none` is allowed only for an app whose `integration.accept` is empty. */
export function checkAcceptRef(value: string | undefined, appAccept: readonly string[]): string[] {
	if (value === undefined) return ["sb: the slip has no accept: line; send accept: <evidence file> | none"];
	if (value.trim() === "") return ["sb: accept: is empty; send accept: <evidence file> | none"];
	if (value.trim().toLowerCase() === "none" && appAccept.length > 0) return [`sb: accept: none is allowed only for an app whose integration.accept is empty (this app requires ${appAccept.join(", ")})`];
	return [];
}

const FILL = "(?:(?:the|it|we|they|is|are|was|were|has|have|had|been|being|that|this|a|an|its|their|our|ever|gets?|got|be) )*";
const STAGE = "(?:deploy\\w*|merg\\w*|land\\w*|releas\\w*|ship\\w*|launch\\w*|rollout|roll out|go live|goes live|went live)";
const WHERE = new RegExp([
	`\\b(?:after|post|once|when|upon|following|before|during|until|while|at|on) ?${FILL}${STAGE}\\b`,
	"\\b(?:on|by|in|via|at|from|with|through|during|using|for|to|before|after) (?:the )?train\\b",
	"\\btrain (?:runs?|does|to run|to do|should|must|will|handles?|can|would|executes?|performs?|accepts?)\\b",
	"部署[之後后]|上線[之後后]|合併[之後后]|合并[之后]|落地後|火車|火车|上車|上车|到站",
].join("|"), "u");

/** Whether free text asks the train to accept a car: an acceptance word (`acceptanceToken`) together with the train or a stage after loading (`after deploy`, `once deployed`, `on the train`, 部署後, 火車). Returns the word it asked for. A target named `uat-env` or a light check that ran e2e asks nothing; `fixed e2e flake; merge after deploy freeze` is refused, and the rewrite is the price of a rule no model text can step around (§18). */
export function asksTrain(value: string): string | undefined {
	const what = acceptanceToken(value);
	return what !== undefined && WHERE.test(spokenText(value)) ? what : undefined;
}

/** Slip keys whose value is read by its own rule and not as free text: the commit and id fields, `departs` and `accept` (parsed to a closed grammar and a `.json` name), and `uat` (always refused). */
const NOT_SCANNED = new Set(["head", "tested-on", "coordinator", "departs", "accept", "uat"]);
const base = (path: string) => path.split(/[\\/]/).pop() ?? path;
const namesCheckpoints = (path: string) => base(path).toLowerCase().split(/[^a-z0-9]+/).some((token) => /^(checkpoints?|conditions?)$/.test(token));

export interface SlipOptions { appAccept: readonly string[] }

/** The refusals of a slip's ticket list over the bound of a car: too many tickets, or a ticket too long. */
export function ticketBound(tickets: readonly string[]): string[] {
	const out: string[] = [];
	if (tickets.length > MAX_CAR_TICKETS) out.push(`sb: slip tickets names ${tickets.length} tickets, and a car carries at most ${MAX_CAR_TICKETS}: split the car into two or more slips`);
	const long = tickets.find((t) => t.length > MAX_TICKET_CHARS);
	if (long !== undefined) out.push(`sb: slip ticket ${shown(long)} is longer than ${MAX_TICKET_CHARS} characters: name the ticket by its id`);
	return out;
}

/** The refusals of the slip itself: how it parses, its head and tickets, `departs`, `accept`, an old `uat:` line, and free text that asks the train for acceptance. */
export function checkSlip(slip: string, { appAccept }: SlipOptions): string[] {
	const { fields, tickets, entries, problems } = parseSlip(slip), out: string[] = [...problems], car = tickets[0] ?? fields.branch ?? "unknown";
	if (!SHA_RE.test(fields.head ?? "")) out.push("sb: slip head must be 40 hex");
	if (tickets.length === 0) out.push("sb: slip tickets is empty");
	out.push(...ticketBound(tickets));
	if (present(fields.uat)) {
		if (fields.uat!.toLowerCase() === "none") out.push("sb: the slip's uat: line is gone; send accept: <evidence file> | none");
		else out.push(acceptanceWord({ car, what: `UAT (${fields.uat})`, where: "slip line uat:" }));
	}
	const accept = fields.accept;
	if (accept !== undefined && accept.toLowerCase() !== "none" && accept !== "") {
		if (namesCheckpoints(accept)) out.push(acceptanceWord({ car, what: `checkpoints or conditions (${accept})`, where: "slip line accept:" }));
		else if (!/\.json$/i.test(accept)) out.push(`sb: accept: ${accept} is not an evidence file (.json)`);
	} else out.push(...checkAcceptRef(accept, appAccept));
	if (present(fields.departs)) {
		const parsed = parseDeparts(fields.departs);
		if (!parsed.ok) out.push(parsed.refusal);
	}
	for (const { key, value, line } of entries) {
		const what = NOT_SCANNED.has(key) ? undefined : asksTrain(value);
		if (what !== undefined) out.push(acceptanceWord({ car, what, where: key === "" ? `slip line ${line}` : `slip field ${key}` }));
	}
	return out;
}

// ---- the evidence file

export interface EvidenceOptions {
	appAccept: readonly string[];
	/** The slip's head: the car's head every entry and `car.head` must name. Left out, `car.head` is the car's. */
	head?: string;
	exists: (path: string) => boolean;
	/** Whether the first commit is an ancestor of the second, as `git merge-base --is-ancestor` says. */
	isAncestor: (older: string, newer: string) => boolean;
}

function entryRefusals(entry: unknown, n: number, car: string, ref: string | undefined, o: EvidenceOptions): string[] {
	const at = `sb: evidence entry ${n}:`;
	if (!isObject(entry)) return [`${at} must be an object`];
	const out: string[] = [], kind = typeof entry.kind === "string" ? entry.kind : "acceptance";
	for (const key of Object.keys(entry)) if (present(entry[key]) && !ENTRY_FIELDS.includes(key)) {
		if (TO_DO.includes(key)) out.push(acceptanceWord({ car, what: kind, where: `evidence entry ${n}: ${key} to be done` }));
		else out.push(`${at} ${key} is not a field`);
	}
	if (!KINDS.includes(entry.kind as string)) out.push(`${at} kind must be e2e, uat or other`);
	else if (entry.kind === "other" && !text(entry.label, 64)) out.push(`${at} kind other needs a label`);
	if (!text(entry.what, 300)) out.push(`${at} what is empty`);
	const result = entry.result;
	if (!present(result) || (typeof result === "string" && PENDING.test(result.trim()))) out.push(acceptanceWord({ car, what: kind, where: `evidence entry ${n}: result ${present(result) ? String(result) : "missing"}` }));
	else if (result !== "passed" && result !== "accepted") out.push(`${at} result must be passed or accepted (got ${JSON.stringify(result)})`);
	for (const key of ["what", "label", "nod"]) {
		const asked = typeof entry[key] === "string" ? asksTrain(entry[key] as string) : undefined;
		if (asked !== undefined) out.push(acceptanceWord({ car, what: asked, where: `evidence entry ${n}: ${key}` }));
	}
	const on = isObject(entry.on) ? entry.on : undefined;
	for (const key of Object.keys(on ?? {})) if (present(on![key]) && !ON_FIELDS.includes(key)) out.push(`${at} on.${key} is not a field`);
	if (!SHA_RE.test(String(on?.head))) out.push(`${at} on.head must be 40 hex`);
	else if (ref !== undefined) {
		const same = on!.head === ref;
		if (present(entry.delta)) {
			if (same) out.push(`${at} delta only goes with an on.head that is an ancestor of the car's head`);
			else if (!o.isAncestor(on!.head as string, ref)) out.push(`${at} on.head is not the car's head`);
			else if (!text(entry.delta) || !o.exists(entry.delta)) out.push(`${at} delta ${String(entry.delta)} does not exist`);
		} else if (!same) out.push(`${at} on.head is not the car's head`);
	}
	if (!text(entry.evidence)) out.push(`${at} evidence is empty`);
	else if (!o.exists(entry.evidence)) out.push(`${at} evidence ${entry.evidence} does not exist`);
	if (!isoTime(entry.at)) out.push(`${at} at must be an ISO time with its zone`);
	if (!text(entry.nod, 2000)) out.push(`${at} nod is empty`);
	return out;
}

/** Whether an evidence file is complete for what the app requires, names the car's head, and points at files that exist (§5.2). */
export function checkEvidence(raw: string, o: EvidenceOptions): string[] {
	const bytes = Buffer.byteLength(raw);
	if (bytes > MAX_EVIDENCE_BYTES) return [`sb: evidence file is ${kb(bytes)} KB, more than ${MAX_EVIDENCE_BYTES / 1024}`];
	let file: unknown;
	try {
		file = JSON.parse(raw);
	} catch (error) {
		return [`sb: evidence file is not JSON (${(error as Error).message})`];
	}
	if (!isObject(file)) return ["sb: evidence file must be a JSON object"];
	const out: string[] = [], car = isObject(file.car) ? file.car : undefined;
	const ticket = Array.isArray(car?.tickets) && typeof car!.tickets[0] === "string" ? (car!.tickets[0] as string) : "unknown";
	for (const old of ["conditions", "checkpoints"]) if (present(file[old])) out.push(acceptanceWord({ car: ticket, what: `UAT ${old}`, where: `evidence file: top-level ${old}, the old format` }));
	for (const key of Object.keys(file)) if (present(file[key]) && !["v", "car", "accepted", "conditions", "checkpoints"].includes(key)) out.push(`sb: evidence.${key} is not a field`);
	if (file.v !== 1) out.push("sb: evidence.v must be 1");
	if (!car) out.push("sb: evidence.car must be an object");
	else {
		for (const key of Object.keys(car)) if (present(car[key]) && !["app", "tickets", "branch", "head"].includes(key)) out.push(`sb: evidence.car.${key} is not a field`);
		if (!(isName(car.app))) out.push("sb: evidence.car.app must be a path-safe name");
		if (!(Array.isArray(car.tickets) && car.tickets.length > 0 && car.tickets.length <= MAX_CAR_TICKETS && car.tickets.every((t) => text(t, MAX_TICKET_CHARS)))) out.push(`sb: evidence.car.tickets must be a list of 1 to ${MAX_CAR_TICKETS} tickets`);
		if (!text(car.branch, 255)) out.push("sb: evidence.car.branch must be a non-empty string");
		if (!SHA_RE.test(String(car.head))) out.push("sb: evidence.car.head must be 40 hex");
		else if (o.head !== undefined && car.head !== o.head) out.push("sb: evidence.car.head is not the slip's head");
	}
	if (!Array.isArray(file.accepted)) {
		out.push("sb: evidence.accepted must be an array");
		return out;
	}
	const ref = o.head ?? (SHA_RE.test(String(car?.head)) ? (car!.head as string) : undefined);
	file.accepted.forEach((entry, i) => out.push(...entryRefusals(entry, i + 1, ticket, ref, o)));
	const entries = file.accepted.filter(isObject);
	for (const required of o.appAccept) if (!entries.some((e) => e.kind === required || (e.kind === "other" && e.label === required)))
		out.push(`sb: acceptance evidence lacks a ${required} entry (the app requires ${o.appAccept.join(", ")})`);
	return out;
}

/** What the code can say of a car's acceptance: the kinds a complete evidence file shows, or that nothing is claimed (`unverified`). */
export type Acceptance = { accepted: string[] } | { unverified: true };

/**
 * A car's acceptance as the code checked it (TB-F003), the one source of the yard's chip: `none` is no acceptance required only for an app that requires none; an evidence file is its entries' kinds (an `other` entry by its label) only when
 * the whole file passes `checkEvidence` with what the app requires. A file that did not read, or fails, claims nothing. A word a model wrote about it is never read.
 */
export function acceptanceOf(accept: string, evidence: string | undefined, o: EvidenceOptions): Acceptance {
	if (accept.trim().toLowerCase() === "none") return o.appAccept.length ? { unverified: true } : { accepted: [] };
	if (evidence === undefined || checkEvidence(evidence, o).length) return { unverified: true };
	const entries = (JSON.parse(evidence) as { accepted: { kind: string; label?: string }[] }).accepted;
	return { accepted: [...new Set(entries.map((e) => (e.kind === "other" && typeof e.label === "string" ? e.label : e.kind)))].slice(0, 8) };
}

export interface CarOptions extends EvidenceOptions {}

/** The slip and its evidence together, as the coordinator checks before it sends and the integrator at receipt. `evidence` is the text of the file the slip's `accept:` names, read by the caller. */
export function checkCar(slip: string, evidence: string | undefined, o: Omit<CarOptions, "head"> & { head?: string }): string[] {
	const out = checkSlip(slip, o), { fields } = parseSlip(slip), accept = fields.accept;
	const isFile = accept !== undefined && !namesCheckpoints(accept) && /\.json$/i.test(accept);
	if (!isFile) return out;
	if (evidence === undefined) out.push(`sb: accept: ${accept} names an evidence file, but it was not read`);
	else out.push(...checkEvidence(evidence, { ...o, head: SHA_RE.test(fields.head ?? "") ? fields.head : undefined }));
	return out;
}

// ---- apps.json

export type AcceptSetting = { ok: true; accept: string[] } | { ok: false; refusal: string };

/** `integration.accept` of an app: the kinds of acceptance a car of it must show evidence of; none by default. */
export function parseAppAccept(value: unknown): AcceptSetting {
	if (value === undefined) return { ok: true, accept: [] };
	const refusal = "sb: integration.accept must be a list of kind names (a-z, 0-9, -; 1 to 32 characters; no repeats)";
	if (!Array.isArray(value) || !value.every((k) => typeof k === "string" && /^[a-z0-9-]{1,32}$/.test(k)) || new Set(value).size !== value.length) return { ok: false, refusal };
	return { ok: true, accept: [...value] };
}

/** An app's `stages` list `merge`, then optionally `deploy`; `uat` moved to `integration.accept` and is a config error (§14.2). */
export function checkStages(stages: unknown): string[] {
	if (stages === undefined) return [];
	if (!Array.isArray(stages)) return ["sb: stages must be a list (merge, then optionally deploy)"];
	const out: string[] = [];
	if (stages.includes("uat")) out.push('sb: stages lists "uat"; move it to integration.accept (a coordinator accepts before loading) and remove it from stages');
	if (stages[0] !== "merge") out.push("sb: stages must start with merge");
	stages.forEach((stage, i) => {
		if (stage === "uat") return;
		if (stage !== "merge" && stage !== "deploy") out.push(`sb: stage "${String(stage)}" is not one of merge, deploy`);
		else if (stages.indexOf(stage) !== i) out.push(`sb: stage "${stage}" twice`);
	});
	return out;
}
