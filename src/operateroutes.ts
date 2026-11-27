import type { Reply } from "./control.ts";
import type { Net } from "./net.ts";

// What an operate session may ask of the box's GUI (docs/specs/2026-11-07-link-operate.md §6.3, §7): the table below is the whole of it, in one place. A request that matches no row is refused. What a row allows then
// runs control.ts, with every guard of a paired device's request (`remote`); what the table refuses never reaches it. Decisions 5 to 9 and 12 make this stricter than remote mode: no shell lines, no /boss commands, no
// bare panes, no spawning or closing of bases, no documents.
//   `path` is the part of the URL after /api/, with `*` for one segment, `a|b` for either, and a closing `**` for any rest. First match wins.
//   `cross`: `request` is a page request answered here, `watch` and `mirror` and `snap` are the stream's own entries (gui.operate), `local` stays on the controller, `refused` is never answered.
//   `box`: only a session whose scope holds the box part (the `box` grant): the tower is the box's, not a team's (§4).
//   `names`: where the unit the request acts on is named, and so which keys the scope must hold.

/** The unit keys an operate session reaches, and whether it holds the box part (docs/specs/2026-11-07-link-operate.md §4): `has` is read at every request, so a roster or policy change takes effect at the next one. */
export interface OperateScope { readonly box: boolean; has(key: string): boolean }
export type Cross = "request" | "watch" | "mirror" | "snap" | "local" | "refused";
type Names = { part: number } | { body: string } | { tab: true };
export interface Row { method: "GET" | "POST" | "STREAM"; path: string; cross: Cross; box?: true; names?: Names; /** Body fields that make the request another one (`dismiss {all}` reaches every team's finished units). */ without?: readonly string[]; note: string }

export const ROUTES: readonly Row[] = [
	{ method: "STREAM", path: "net", cross: "snap", note: "The net snapshot, sliced to the scope (operateslice.ts), on change." },
	{ method: "STREAM", path: "watch", cross: "watch", note: "A session's history and a workspace's cards (events?watch=)." },
	{ method: "STREAM", path: "mirror", cross: "mirror", note: "The terminal mirror's frames." },
	{ method: "STREAM", path: "hello|ping|view|problem", cross: "local", note: "The controller's own server makes these for its pages." },

	{ method: "GET", path: "history/*", cross: "request", names: { part: 1 }, note: "A page of a session's history." },
	{ method: "GET", path: "entry/*/*", cross: "request", names: { part: 1 }, note: "One entry in full." },
	{ method: "GET", path: "image/*/*/*", cross: "request", names: { part: 1 }, note: "An entry's image." },
	{ method: "GET", path: "transcripts", cross: "request", note: "The box's finished runs, in the session's scope (watch.ts, server/operateledger.ts, §9)." },
	{ method: "GET", path: "music/**", cross: "local", note: "The controller plays its own." },
	{ method: "GET", path: "doc/**", cross: "refused", note: "Documents are never served over operate (decision 12)." },
	{ method: "GET", path: "lan/**", cross: "refused", note: "Wi-Fi access is this computer's own." },

	{ method: "POST", path: "sessions/*/input", cross: "request", names: { part: 1 }, note: "Send and follow-up; no `!` line and no /boss command (§7)." },
	{ method: "POST", path: "sessions/*/keys", cross: "request", names: { part: 1 }, note: "The pad, typed text, paste, chords, Stop; Enter is probed (§7)." },
	{ method: "POST", path: "sessions/*/answer", cross: "request", names: { part: 1 }, note: "A dialog's answer; hereOnly choices and a secret `value` stay refused (decision 7)." },
	{ method: "POST", path: "sessions/*/dequeue", cross: "request", names: { part: 1 }, note: "Edit: takes the queue back." },
	{ method: "POST", path: "sessions/*/commands", cross: "request", names: { part: 1 }, note: "Slash completion, a read." },
	{ method: "POST", path: "sessions/*/upload", cross: "request", names: { part: 1 }, note: "A pasted file, at most 2 MB (decision 11)." },
	{ method: "POST", path: "sessions/*/mirror", cross: "mirror", names: { part: 1 }, note: "Attaches the terminal mirror: the session's mirror() takes it, on its own stream." },
	{ method: "POST", path: "sessions/*/focus", cross: "refused", note: "It brings a pane forward on a screen nobody looks at." },
	{ method: "POST", path: "sessions/**", cross: "refused", note: "No such action on a session." },

	{ method: "POST", path: "dismiss", cross: "request", names: { body: "key" }, without: ["all"], note: "Hides one finished subagent; `all` would reach other teams' units." },
	{ method: "POST", path: "close/unit", cross: "request", names: { body: "key" }, note: "Quits one session." },
	{ method: "POST", path: "close/tab", cross: "request", names: { tab: true }, note: "Quits a squad: every unit in the tab must be in scope." },
	{ method: "POST", path: "close/base", cross: "refused", note: "A base holds the box's tower and other teams' units (decision 9)." },
	{ method: "POST", path: "close/stash", cross: "refused", note: "As close/base." },
	{ method: "POST", path: "close/all", cross: "refused", note: "As close/base." },
	{ method: "POST", path: "close/pop", cross: "refused", note: "Opening a stash is spawning (decision 9)." },
	{ method: "POST", path: "open/**", cross: "refused", note: "A new main opened this way would belong to no team (decision 9); work still reaches the box by dispatch." },
	{ method: "POST", path: "dirs/**", cross: "refused", note: "The folder picker is for opening (decision 9)." },

	{ method: "POST", path: "tower/*/memory|leave|new|retry|deliver|drop", cross: "request", box: true, note: "The tower is the box's, so only the box part may steer it." },
	{ method: "POST", path: "tower/**", cross: "refused", note: "No such action on a tower." },

	{ method: "POST", path: "doc/**", cross: "refused", note: "Documents are never served over operate (decision 12)." },
	{ method: "POST", path: "panes/**", cross: "refused", note: "A pane an answer opened runs a shell (decision 8)." },
	{ method: "POST", path: "trust/**", cross: "refused", note: "Project trust on the box is its infrastructure's." },
	{ method: "POST", path: "link/**", cross: "refused", note: "The box's own team settings." },
	{ method: "POST", path: "server/**", cross: "refused", note: "Box-wide, and this computer's page only already." },
	{ method: "POST", path: "remote/**", cross: "refused", note: "As server." },
	{ method: "POST", path: "lan/**", cross: "refused", note: "As server." },
	{ method: "POST", path: "head/**", cross: "refused", note: "The head tower is box-wide." },
	{ method: "POST", path: "auto/**", cross: "refused", note: "Auto mode is this computer's own switch (a paired phone's too), never a box's." },
	{ method: "POST", path: "asks/**", cross: "refused", note: "The questions to the boss are this computer's own store (docs/specs/2026-11-28-boss-asks.md): a box's are asked on the box." },
	{ method: "POST", path: "board/**", cross: "refused", note: "The work board is this computer's own page (Clear): a box's board is another computer's." },
];

const segment = (pattern: string, part: string | undefined) => part !== undefined && part !== "" && (pattern === "*" || pattern.split("|").includes(part));
/** Whether a path (the parts after api/) is the row's. */
function matches(row: Row, parts: string[]): boolean {
	const want = row.path.split("/"), rest = want.at(-1) === "**";
	const fixed = rest ? want.slice(0, -1) : want;
	if (rest ? parts.length < fixed.length : parts.length !== fixed.length) return false;
	return fixed.every((pattern, i) => segment(pattern, parts[i]));
}
/** The row of a request, first match wins; none when the table does not know it (which refuses it). */
export const routeOf = (method: "GET" | "POST", parts: string[]): Row | undefined => ROUTES.find((r) => r.method === method && matches(r, parts));

/** What the table says of a request: `request`, `box` (a request, the box part only), `mirror` (the stream's own entry), or `refused`. */
export function verdictOf(method: "GET" | "POST", parts: string[]): "request" | "box" | "mirror" | "refused" {
	const row = routeOf(method, parts);
	return !row ? "refused" : row.cross === "request" ? (row.box ? "box" : "request") : row.cross === "mirror" ? "mirror" : "refused";
}

/** A line pi runs as a shell command, and a `/boss` command (not `/bossy`): the composer's text and the editor's draft are checked by these (probe.ts holds the editor's twin). `\s` is JavaScript's, as pi's own trim. */
export const SHELL_LINE = /^\s*!/, BOSS_LINE = /^\s*\/boss(\s|$)/;
export type Why = "route" | "out-of-scope" | "shell" | "boss-command" | "bad-request" | "foreground";
export type Plan = { ok: true; row: Row; keys: string[]; tab?: { workspace: string; tab: string } } | { ok: false; why: Why; reason: string };
const no = (why: Why, reason: string): Plan => ({ ok: false, why, reason });
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;

/**
 * The table, the unit and the text of a request, before anything runs: the row it falls on, the unit keys it names (each in the scope, or refused), and for `close/tab` the tab it names (the seam checks its units against
 * the net). `via` is the entry asking: a request, or the session's `mirror` (which takes the one row that crosses by it). `body` is the request's JSON (anything else than an object is a bad request: a frame's body is decoded from the wire); an upload's bytes name no field.
 * `roleOf` is the registry's role of a unit key: the head tower is never an operate session's, and a service tower is the box's, whatever `has` says (defence in depth beside the table's `head/**` and `tower/*` rows).
 */
export function plan(method: "GET" | "POST", parts: string[], body: Record<string, unknown> | Buffer, scope: OperateScope, via: Cross = "request", roleOf: (key: string) => string | undefined = () => undefined): Plan {
	const row = routeOf(method, parts), json = Buffer.isBuffer(body) ? {} : body;
	if (!row) return no("route", "An operate session does not offer this.");
	if (row.cross === "refused" || row.cross === "local") return no("route", row.note);
	if (row.cross !== via) return no("route", "This goes through the session's own stream entry, not a request.");
	if (!Buffer.isBuffer(body) && (typeof body !== "object" || body === null || Array.isArray(body))) return no("bad-request", "The body is not a JSON object.");
	if (row.box && !scope.box) return no("out-of-scope", "That belongs to the box itself, which this grant does not reach.");
	if (row.without?.some((field) => json[field] !== undefined)) return no("route", row.note);
	let keys: string[] = [], tab: { workspace: string; tab: string } | undefined;
	const names = row.names;
	if (names && "part" in names) keys = [parts[names.part]!];
	else if (names && "body" in names) {
		if (!str(json[names.body])) return no("bad-request", "Name the unit by its key.");
		keys = [json[names.body] as string];
	} else if (names) {
		if (!str(json.workspace) || !str(json.tab)) return no("bad-request", "Name the squad by its base and tab.");
		tab = { workspace: json.workspace, tab: json.tab };
	}
	if (keys.some((key) => !scope.has(key))) return no("out-of-scope", "That unit is not one this session reaches.");
	if (keys.some((key) => roleOf(key) === "head")) return no("route", "The head tower is box-wide: an operate session does not reach it."); // every row that names a unit, not only sessions/*
	if (row.path.startsWith("sessions/") && !scope.box && keys.some((key) => roleOf(key) === "tower")) return no("out-of-scope", "That belongs to the box itself, which this grant does not reach.");
	if (row.path === "sessions/*/input" && typeof json.text === "string") {
		if (SHELL_LINE.test(json.text)) return no("shell", "A shell line (`!`) is not run from here: the box takes no arbitrary shell over the link.");
		if (BOSS_LINE.test(json.text)) return no("boss-command", "A /boss command is not run from here: on the box it reaches other teams' sessions and the box's own settings.");
	}
	return { ok: true, row, keys, ...(tab ? { tab } : {}) };
}

/** The units in a tab of the net (each with its subagents), or undefined when the net shows no such tab, or none in it: a squad the net does not show is not one to close. */
export function unitsOfTab(net: Net, workspace: string, tab: string): string[] | undefined {
	const found = net.bases.find((b) => b.id === workspace)?.tabs.find((t) => t.id === tab);
	return found?.units.length ? found.units.flatMap((u) => [u.key, ...u.subs.map((s) => s.key)]) : undefined;
}

export const OPERATE_REFUSED = "operate_refused";
/** The reply for a refusal of `plan`: 403 `operate_refused` with a reason word, or 400 for a body that does not name its unit. */
export const refusalReply = (no: Extract<Plan, { ok: false }>): Reply => (no.why === "bad-request" ? { status: 400, body: { error: "bad_request", reason: no.reason } } : { status: 403, body: { error: OPERATE_REFUSED, why: no.why, reason: no.reason } });
