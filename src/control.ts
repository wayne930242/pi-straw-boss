import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { MAX_PREFIX } from "./commands.ts";
import { type Grants, panes, thenOf } from "./answerpane.ts";
import { ANSWER_ID, checkAnswer, CONTROL, type Hub, type Sent, type Target } from "./dialogs.ts";
import { HerdrError, type HerdrCall, type Pane } from "./herdr.ts";
import { defaultDequeue, keyLabel } from "./dequeuekey.ts";
import { createKeys } from "./keys.ts";
import { createRuns } from "./runs.ts";
import type { Asked } from "./gui.ts";
import type { Overlay } from "./lan/faces.ts";
import { linkRequest as linkRequestOwner } from "./owners.ts";
import type { createMirrors } from "./mirror.ts";
import type { Found, RunDialog } from "./net.ts";
import { upload } from "./upload.ts";
import { ENDING, operateKeyRefusal, operateRawRefusal, operateTextRefusal } from "./probe.ts";
import { OPERATE_REFUSED } from "./operateroutes.ts";
import { qr } from "./qr.ts";
import { parseOpen } from "./bossopen.ts";
import { parseSend } from "./bosssend.ts";
import { answersOf, commandReply, headRoutes, markAnswered } from "./headroutes.ts";
import type { RemoteBridge } from "./server/operatehost.ts";
import { type Answered, recordBlock } from "./answered.ts";

// Typing into a session from the page, through Herdr's own input path only, as if typed in the terminal:
//   POST /<token>/api/sessions/<key>/input {text, as: "send" | "followUp", confirmed?, answers?, block?}   the text, then Enter (or Alt+Enter while it works); to a tower, a boss event, and `answers: "W3"` names the wait for the boss it answers (the memory marks it answered once the tower took the message)
//   POST /<token>/api/sessions/<key>/keys  {key, stream, confirmed?}                     one key pad key under its mirror (keys.ts), or Stop's {keys: ["esc"]}
//   POST /<token>/api/sessions/<key>/focus                                               brings the session's pane forward in Herdr
//   POST /<token>/api/sessions/<key>/commands {prefix}                                   its commands that match a typed `/prefix`, from its bridge (commands.ts); null when it did not say
//   POST /<token>/api/sessions/<key>/dequeue {take}                                      takes the queue back: pi's dequeue key (Alt+Up, Alt+Q on Windows and WSL, or the user's binding: dequeuekey.ts), then the pulled messages' text for the composer (pull.ts); {empty: true} when nothing was queued; the same `take` asked again gets the text the session kept
//   POST /<token>/api/sessions/<key>/answer {dialog, digest, answerId, choice | answers}  answers its dialog through its bridge (dialogs.ts); no keys; a `value` (a secret) is refused from every page (SB-F001)
//   POST /<token>/api/sessions/<key>/upload (the file's bytes)                            stores a pasted, dropped, or picked file, answers its path (upload.ts)
//   POST /<token>/api/sessions/<key>/mirror {stream, on}                                  shows the pane's screen on that page's stream (mirror.ts), or stops
//   POST /<token>/api/panes/<grant>/mirror {stream, on}, /keys {key, stream}               the same for a Herdr pane an accepted answer opened (answerpane.ts; robot_hand's new pane): by the grant the answer returned in `then.pane`, never a pane id; the keys are the pad's, a chord's, typed text, and a paste (keys.ts `bare`), for the boss's page and a paired device alike
//   POST /<token>/api/remote/pair                                                        a new one-time pairing URL and its QR, while remote access is on (this computer only, never a paired device)
//   POST /<token>/api/remote/on, remote/off                                              turns remote access on in the server's session, then a pairing URL and its QR, or off (never remote)
//   POST /<token>/api/remote/devices, remote/unpair {id}, remote/unpair-all             the paired devices, and unpairing one or all (never remote)
//   POST /<token>/api/lan/on {accept_risk?}, lan/off, lan/pair {surface, form, address?}, lan/approve {number} | {deny}, lan/ca   Wi-Fi access (lan/*, docs/specs/2026-10-30-sb-gui-lan.md; this computer's page only, never a paired device, whatever its network)
//   POST /<token>/api/dismiss {key} or {all: true}                                       hides one finished subagent, or every finished one, from every page
//   POST /<token>/api/close/unit, close/tab, close/base                                   quits a session, or every agent of a squad or base, then closes it (closer.ts)
//   POST /<token>/api/close/stash {workspace, name}                                       checks and records a base, then closes it as close/base does (stash.ts); a paired device may, as it may close/base
//   POST /<token>/api/dirs, open/base, open/member, open/main                            a folder picker, a new base with a member, a new member, a new main (spawn.ts)
//   POST /<token>/api/doc/<capability>/answer {answerId, answer, rev}                   one answer from a block of a Markdown document the page draws (docs.ts `answer`): a v2 owner takes the Answer, a v1 owner the form answer of an HTML document (this computer's page and a paired device alike; an operate session never)
//   POST /<token>/api/trust/answer {id, digest, choice, answerId}                       answers a project trust question (trust/serve.ts); a paired device may, as it may answer a relayed confirm
//   POST /<token>/api/tower/<workspace>/memory {op, …}                                   the tower's memory panel (towermemory.ts `memoryRequest`, the very function `/boss memory` reaches over the control socket's `tower-memory`): read, add, edit, delete, resolve, confirm or reject a run's proposal; a write carries the rev it read (409 `rev` when the file moved on); a paired device may, as it may use the composer
//   POST /<token>/api/tower/<workspace>/leave, /new                                    leaves the boss conversation, or starts over (the next one is a new session): runs.ts `leave` and `fresh`, the functions `/boss tower leave|new` and the tower prompt's `/new` reach over the control socket; exactly `/quit` and `/new` typed in the tower's composer do the same; a paired device may, as it may use the composer
//   POST /<token>/api/link/<name> {…}                                                    Straw Link's team settings, through the link holder (link.ts of the page): state, create, invite, decide, join-start, trust, …
//                                                                                        This computer's page only, except `state` (without a pending invite's text), `confirm-answer`, and `dialog-answer`, which a paired device may do like it answers any confirm
//   POST /<token>/api/server/stop {by, take}                                             stops the GUI listeners: an older session's /boss gui stop or takeover (never remote)
//   POST /<token>/api/server/status, server/restart {reason?}, server/log {lines?}       the sb server's state, restarting it (the new server's GUI keeps this address unless a port was taken, so this page reconnects), and the last lines of its log (this computer's page only)
// Every write needs the page's own origin (Origin, Sec-Fetch-Site), a JSON body of at most 64 KB, and the CSRF secret the server wrote into
// the page; the custom header forces a CORS preflight that is never approved. The key is resolved in the registry (paths and panes never come
// from the browser), and Herdr is asked right then that the pane still runs pi on that session's file, so a reused pane id is refused.
// One request per session is in flight at a time. Typed text is never logged; a Herdr timeout is not retried: it does not prove nothing arrived.

export const MAX_TEXT = 16_384, MAX_BODY = 65_536, MAX_REMOTE_UPLOAD = 2 * 1024 * 1024;
/** The first parts of every path this control answers (gui.ts routes them here); operateroutes.ts has a row for each. */
export const SCOPES = ["sessions", "panes", "remote", "server", "dirs", "open", "close", "dismiss", "trust", "link", "tower", "head", "lan", "doc", "board", "auto"];
/** Who is asking, as the guards need it: `remote` a paired device (or an operate session), `secure` a page served over https (which says where a secret is answered), `operate` an operate session's request, which also meets the box's own refusals (docs/specs/2026-11-07-link-operate.md §7). */
export interface Flags { remote: boolean; secure: boolean; operate?: true; /** An operate session's look at the pane's foreground (foreground.ts), made inside the job right before each write: whether pi, and nothing a pi key opened in its place, holds the pane's terminal. Without it an operate write is refused. */ foreground?(pane: string): Promise<boolean>; /** Whether the operate session that asked is still there: looked at last, after every await before a write, so a request admitted before a revoke does not write after the session ended (docs/specs/2026-11-07-link-operate.md §11.8, BR-F008). */ alive?(): boolean }
export { ENDING };

export interface Reply { status: number; body: unknown }
/** The page's way to Wi-Fi access (server/lanhost.ts): the tile's routes. `surface` is the tile's own id per tab. */
export interface LanPanel {
	on(json: Record<string, unknown>): Promise<Reply>;
	off(): Promise<Reply>;
	pair(json: Record<string, unknown>): Promise<Reply> | Reply;
	approve(json: Record<string, unknown>): Promise<Reply> | Reply;
	ca(): Promise<Reply> | Reply;
	/** The pending requests (no number), the events, and the notes; the tile polls it. `peek` reads without counting as an open tile (the page's waiting-request notice, which must not silence the sessions' own). */
	pending(peek?: boolean): Reply;
	/** A public certificate file for **Share the certificate**: `straw-boss.mobileconfig` or `straw-boss-lan-ca.crt`. */
	file(name: string): { type: string; bytes: Buffer } | undefined;
}
/** The page's way to Straw Link's holder (runtime.ts `gui`): a named request with arguments, and the setup marker that starts the election before any team exists. */
export interface LinkPort { call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; error?: string; code?: string; [key: string]: unknown }>; enable(): Promise<void> }
/** The sb server's panel on the page (server.ts of the page): its state, a restart with a reason, and the last lines of its log. */
export interface ServerPanel { status(): unknown; restart(reason: string): Promise<Reply>; log(lines: number): string[] }
/**
 * The tower service the sb server runs for a workspace (docs/specs/2026-10-26-sb-backend.md, GUI): the composer writes to it as the boss (an event, which wakes a run), a run's notices have their buttons
 * (retry the crash loop, deliver a parked event again or drop it), and a tower with no live run has no terminal for keys or a mirror (409 `standing`).
 */
export interface TowerPanel {
	has(workspace: string): boolean;
	live(workspace: string): boolean;
	/** `door`: written on this computer's own page (with headless runs a run may then show the boss a card). */
	event(workspace: string, text: string, door?: "page"): Promise<{ ok: boolean; error?: string }>;
	act(workspace: string, what: "retry" | "deliver" | "drop", id?: string): Promise<{ ok: boolean; error?: string }>;
	/** The boss leaves the conversation, or starts a fresh one (runs.ts `leave`, `fresh`): the pi twins are `/boss tower leave` and `/boss tower new`, which reach the same functions over the control socket. */
	conversation?(workspace: string, what: "leave" | "new"): Promise<{ ok: boolean; error?: string; left?: boolean; fresh?: boolean; already?: boolean }>;
	/** The memory panel's request (towermemory.ts `memoryRequest`): read the boss's standing instructions, decisions, and waits, or change them as the boss; a write names the rev it read. */
	memory?(workspace: string, json: Record<string, unknown>, door?: "gui" | "phone" | "box"): Promise<Reply> | Reply;
	/** The boss closes the tower (the head's Close; a workspace tower closes through the base's own route). */
	close?(workspace: string): Promise<{ ok: boolean; error?: string }>;
	/** Whether the key is the head tower's (its constant key or its Herdr workspace): the head answers api/head/… only, so api/tower/… refuses it. */
	isHead?(workspace: string): boolean;
	/** Headless runs (docs/specs/2026-11-23-f-entry.md §2.8): the dialogs a tower's runs wait on (the head's: every run's), for this computer's own page only. */
	dialogs?(workspace: string): RunDialog[];
	/** The page's answer to one of those dialogs: refused for a key that is not one of the workspace's. */
	answer?(workspace: string, key: string, reply: { value?: string; confirmed?: boolean; cancelled?: boolean }): Promise<{ ok: boolean; error?: string }>;
	/** Open viewer: `ensure-tower {view: true}`, a viewer tab when none runs. */
	viewer?(workspace: string): Promise<{ ok: boolean; error?: string }>;
	/** The head composer's `@<workspace> <text>`: the boss's words straight to that tower; `page` when this computer's own page wrote it. */
	direct?(to: string, text: string, door?: "page"): Promise<{ ok: boolean; error?: string; label?: string }>;
	/** The text the workspace's live run is writing now, for the comms' `live` ("" when none). */
	liveText?(workspace: string): string;
}
/** Auto mode's panel (server/autoops.ts): the switch, the head's pending `on` and its confirm, all the server's own state. A write here is the boss's own act (the page's token and CSRF, a paired phone too); an operate session never reaches it. */
export interface AutoPanel { /** What the page snapshot carries (net.ts `AutoSnap`): undefined when auto mode is off and nothing waits. */ snap(): { on: boolean; since?: string; pending?: { id: string; said: string; expires: number } } | undefined; /** Whether this server can switch auto mode at all (not an unattended device): the page shows its chip only then. */ available(): boolean; state(): Reply; /** The last return list, or `{ report: null }` (the page's return panel). */ report(): Reply; set(on: boolean, remote: boolean): Reply; confirm(id: unknown, remote: boolean): Reply }
/** What a paired device may ask: read the state, answer a forwarded confirm or dialog, and ask a box to stop one main (a graceful stop the box decides on; docs/specs/2026-11-07-link-remote-stop.md, decision 10). Everything else changes who may command this computer, so only its own page does it. */
const REMOTE_LINK = ["state", "confirm-answer", "dialog-answer", "unit-stop"];
const LINK_NAMES = ["enable", "state", "create", "invite", "invite-text", "invite-cancel", "decide", "join-start", "join-project", "join-cancel", "prefill-clear", "remove", "role", "rotate", "trust", "leave", "confirm-answer", "dialog-answer", "unit-stop", "operate", "operate-off", "operate-on"];
/** `tower`: the sb server's tower service, when it runs one (TowerPanel). */
/** `answers.target` reads the net afresh, so the binding and the dialog are checked again for every answer. */
export interface ControlDeps { /** Auto mode (server/autoops.ts): `auto {on}` and `auto/confirm {id}`. */ auto?: AutoPanel; /** The work board's Clear (server/boardpanel.ts): `board/clear {session}`, decided from the server's own reading. */ board?: { clear(json: Record<string, unknown>): Promise<Reply> }; /** The units of the boxes this computer operates (server/operatehost.ts): a request that names one goes to its session, after the guards a paired device's write meets, and never to a local route. */ bridge?: Pick<RemoteBridge, "claim">; lan?: LanPanel; /** The marks of the `/boss gui lan` overlay: a paired device's write into a marked pane is Escape only (lan/faces.ts). */ overlay?: Overlay; lookup(key: string): Found | undefined; call?: HerdrCall; csrf: string; canonical(file?: string): string | undefined; pair?(): { url: string; rows: string[] } | undefined; remoteOn?(): Promise<void>; remoteOff?(): Promise<void>; tower?: TowerPanel; paired?: { on(): boolean; list(): unknown; unpair(id: string): boolean; unpairAll(): number; unsaved(): string | undefined }; saveFailed?(reason: string): void; spawn?(parts: string[], json: Record<string, unknown>): Promise<Reply>; close?(kind: string, json: Record<string, unknown>, refresh?: () => Promise<unknown>): Promise<Reply>; dismiss?(key: unknown): Promise<boolean>; dismissAll?(): Promise<number>; stop?(asked: Asked): boolean | void; link?: LinkPort; /** The panes accepted answers opened (answerpane.ts). */ grants?: Pick<Grants, "before" | "claim" | "get" | "live" | "drop">; server?: ServerPanel; mirrors?: Pick<ReturnType<typeof createMirrors>, "toggle" | "fresh">; secret?(file: string): Promise<boolean>; linkRequest?(file: string): Promise<boolean>; answers?: Pick<Hub, "has" | "replay" | "ended" | "send" | "probe" | "commands" | "pull"> & { target(key: string): Promise<Target | undefined> }; trust?(json: Record<string, unknown>): Promise<Reply>; /** The documents the page shows (docs.ts): the answer of a Markdown block. */ docs?: { answer(cap: string, json: Record<string, unknown>): Promise<Reply> }; /** The record of answered blocks (answered.ts): a chat block's `input` carries `block {entry, index, fields}` and is recorded in the same request. */ answered?: Answered }

const no = (status: number, error: string, reason: string, extra = {}): Reply => ({ status, body: { error, reason, ...extra } });

/**
 * `POST api/tower/<workspace>/dialog {key, confirmed | value | cancelled}` answers a headless run's dialog, and `…/viewer` opens the tower's viewer tab (docs/specs/2026-11-23-f-entry.md §2.8). Both are this computer's own page's:
 * a paired device or a box's controller is refused (`far`), as the `NO_RELAY` approvals say. Exported for the head's routes, which take `head/dialog` the same way.
 */
export async function runRoute(tower: TowerPanel | undefined, workspace: string, action: "dialog" | "viewer", json: Record<string, unknown>, far: boolean): Promise<Reply> {
	if (far) return no(403, "local_only", action === "dialog" ? "A tower run's dialog is answered on this computer's own page or in a viewer, never from a paired device." : "A viewer tab opens on this computer's own page.");
	if (action === "viewer") {
		if (!tower?.viewer || !tower.has(workspace)) return no(404, "not_found", "No such tower.");
		const done = await tower.viewer(workspace);
		return done.ok ? { status: 200, body: { opened: true } } : no(409, "refused", done.error ?? "The tower refused it.");
	}
	const key = typeof json.key === "string" && json.key.length <= 200 ? json.key : undefined;
	if (!key) return no(400, "bad_request", "Name the dialog.");
	if (!tower?.answer || !tower.has(workspace)) return no(404, "not_found", "No such tower.");
	const reply = { ...(typeof json.value === "string" && json.value.length <= 4000 ? { value: json.value } : {}), ...(typeof json.confirmed === "boolean" ? { confirmed: json.confirmed } : {}), ...(json.cancelled === true ? { cancelled: true } : {}) };
	const done = await tower.answer(workspace, key, reply);
	return done.ok ? { status: 200, body: { answered: true } } : no(409, "refused", done.error ?? "The dialog was not answered.");
}
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The request body as JSON, or the reply that refuses it. A body past the limit is drained, not kept. */
function body(req: IncomingMessage): Promise<Reply | { json: Record<string, unknown> }> {
	return new Promise((done) => {
		const parts: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => ((size += chunk.length) <= MAX_BODY && parts.push(chunk)));
		req.on("error", () => done(no(400, "bad_request", "The request could not be read.")));
		req.on("end", () => {
			if (size > MAX_BODY) return done(no(413, "too_large", "The request is larger than 64 KB."));
			try {
				const json = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
				done(json && typeof json === "object" && !Array.isArray(json) ? { json } : no(400, "bad_request", "The body is not a JSON object."));
			} catch {
				done(no(400, "bad_request", "The body is not JSON."));
			}
		});
	});
}

/** The bytes of a request body of at most `max`, or the reply that refuses it (a body past the limit is drained, not kept). */
function bytesOf(req: IncomingMessage, max: number): Promise<Buffer | Reply> {
	return new Promise((done) => {
		const parts: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => ((size += chunk.length) <= max && parts.push(chunk)));
		req.on("error", () => done(no(400, "bad_request", "The file could not be read.")));
		req.on("end", () => done(size > max ? no(413, "too_large", "The file is larger than 2 MB.") : Buffer.concat(parts)));
	});
}

/** Herdr's refusal as the page sees it; its own code is kept. */
function refused(error: unknown): Reply {
	const code = error instanceof HerdrError ? error.code : "herdr_error";
	if (code === "timeout") return no(504, code, "Herdr did not confirm it in time. Check the terminal before sending again.");
	if (["agent_blocked", "agent_not_found", "agent_not_ready", "pane_not_found"].includes(code)) return no(409, code, code === "agent_blocked" ? "It is waiting on a dialog; answer it in the terminal." : "The pane no longer runs this session.");
	return no(502, code, (error as Error).message);
}

/** What the page hears when taking the queue back cannot be done, by the bridge's reason (pull.ts). */
const PULL_WHY: Record<string, string> = {
	no_key: "pi's dequeue key (app.message.dequeue in its keybindings.json) is not one this page can send; press it in the terminal.",
	no_editor: "This session has no editor to take the messages back into.",
	stale: "The take-back timed out, or the session changed, after the key went: the messages are in the terminal's editor, not here.",
	changed: "The terminal's editor holds something other than the queued messages and the draft (typed meanwhile, or a message pi expanded); the messages are in it, check the terminal.",
	too_large: "The queued messages are too long to bring here; they are in the terminal's editor.",
	not_cleared: "The messages could not be cleared from the terminal's editor; they are there, not here.",
};

/** pi did not clear its queue after the key: the key may not be its dequeue key (a binding that changed since the bridge named it, or an older bridge's guess). */
const notTaken = (sent: string) => `pi did not take its queue back; its dequeue key may not be ${keyLabel(sent)}. Check the terminal.`;

/** The text as it will be typed, or why it cannot be: CRLF and lone CR become LF, then the size and character checks. */
export function checkText(text: unknown): string | Reply {
	if (typeof text !== "string" || !text.trim()) return no(400, "bad_request", "There is no text to send.");
	const typed = text.replace(/\r\n?/g, "\n");
	if (Buffer.byteLength(typed) > MAX_TEXT) return no(413, "too_large", "The text is longer than 16 KB.");
	if (CONTROL.test(typed)) return no(400, "control_character", "Control characters cannot be typed from the browser."); // they would act as keys inside the paste
	return typed;
}

const OVERLAY_OPEN = "A /boss gui lan screen is open in this session; only Escape can be sent to it from a paired device.";
/** Boss commands that manage pairing, remote access, Wi-Fi, or the server: a paired device's composer and a new session's first message never run them, nor `gui view <mode>` (the local page and the terminal do). A slip guard, not a boundary: the key pad's terminal keys are not filtered. */
const BOSS_LOCAL = /^\s*\/boss\s+(gui\s+(stop|rotate|remote|lan|devices|unpair|view\s+\S+)|server|lan|answer|link\s+decide)(?=\s|$)/;
/** The Straw Link subcommands that change who may command this computer or answer for it, a team's roster or its key (bosslink.ts), and the ones that show a credential or a teammate's call: the same slip guard as `link decide`. `link` and `link status` stay readable. */
const BOSS_LINK_LOCAL = /^\s*\/boss\s+link\s+(on|confirms?|asks|answer|invite|join|create|leave|operate|trust|role|remove|rotate)(?=\s|$)/;
const BOSS_OPEN = /^\s*\/boss\s+open\s+([\s\S]*)$/, BOSS_SEND = /^\s*\/boss\s+send(?=\s|$)([\s\S]*)$/;
/** A text a paired device may not send: a local-only /boss command, or a `/boss open` whose first message, or a `/boss send` whose text (at any depth), is one, since the new pane or the other session would run it from this computer. */
export const localOnlyText = (text: string): boolean => {
	if (BOSS_LOCAL.test(text) || BOSS_LINK_LOCAL.test(text)) return true;
	const inner = parseOpen(BOSS_OPEN.exec(text)?.[1])?.text ?? parseSend(BOSS_SEND.exec(text)?.[1])?.text;
	return inner !== undefined && localOnlyText(inner);
};
const LOCAL_ONLY = "Pairing, remote access, Wi-Fi, the server, the default view, deciding a join request, and answering another session's dialog are managed on this computer's own page or terminal, not from a paired device.";
/** What a guarded post from this computer is refused with: the boss typed a /boss send here, and the server holds it to the guards a remote write meets because the session it runs in may have been typed into from elsewhere. */
const GUARDED = "A /boss send is held to the guards of a remote write (the session it runs in may be driven from elsewhere): this needs this computer's own page, or type it in that session's own terminal.";
const LINK_LOCAL = "While it waits on a link request, a paired device can only send Escape; approve it on this computer's own page or terminal.";
export function createControl({ auto, board, bridge, lan, overlay, link, server: panel, lookup, call, csrf, canonical, pair, remoteOn, remoteOff, paired, saveFailed, spawn, close, dismiss, dismissAll, stop, mirrors, grants, secret = async () => true, linkRequest = async () => false, answers, trust, tower, docs, answered }: ControlDeps) {
	const busy = new Set<string>();
	// A change to the paired devices or the remote wish that could not be written to paired.json took effect in memory only: say so (500), to the page and the session.
	const lost = (): Reply | undefined => {
		const reason = paired?.unsaved();
		return reason ? (saveFailed?.(reason), no(500, "save_failed", reason)) : undefined;
	};
	// A link_request is open when the session file shows its call or the runtime that owns the approval relays its dialog (a call nested in codemode is not in the file).
	/** An operate session's write goes only while pi is in the pane's foreground and holds the terminal, looked at right before it (the box's own refusal, the last of the guards): Herdr's process list, then pi's raw mode again. An editor that pi starts sits in pi's own group, beside pi, so the list cannot see it; only `raw` can, and an earlier probe may be up to 4 s old. */
	const foremost = async (foreground: Flags["foreground"], pane: string, session: string, alive?: Flags["alive"]) => {
		if (!(await foreground?.(pane).catch(() => false))) throw no(403, OPERATE_REFUSED, "Something other than pi may hold the pane's terminal (or Herdr cannot say), so nothing is sent from here.", { why: "foreground" });
		const barred = operateRawRefusal(await answers?.probe(session, undefined, true));
		if (barred) throw no(403, OPERATE_REFUSED, barred.reason, { why: barred.why });
		if (alive && !alive()) throw no(403, OPERATE_REFUSED, "The session ended, so nothing is sent from it.", { why: "ended" });
	};
	const requested = async (key: string, found: Found) => (await linkRequest(found.file!)) || Boolean(answers?.has(key, linkRequestOwner.name, found));
	const runs = createRuns(), pad = createKeys({ overlay, run: runs, fresh: (id, key, pane) => mirrors?.fresh(id, key, pane) ?? false, secret, answerable: async (key) => Boolean(await answers?.target(key)), linkRequest: async (found, key) => (await linkRequest(found.file!)) || Boolean(answers?.has(key, linkRequestOwner.name, { pane: found.pane, file: found.file })), probe: async (key, nonce, flags) => answers?.probe(key, nonce, flags) });
	/** The HTTP shell: the origin, the content type, and the CSRF secret, then the body as JSON, which `run` takes from there. `parts` is the path after api/: sessions/<key>/<action>, remote/pair, or server/stop. */
	async function handle(req: IncomingMessage, origin: string, [scope, key = "", action = "", ...extra]: string[], remote = false): Promise<Reply> {
		if (req.method !== "POST") return no(405, "method", "Use POST.");
		if (extra.length) return no(404, "not_found", "No such action."); // a path has three parts at most; a fourth was dropped and the rest answered
		const site = req.headers["sec-fetch-site"], type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
		if (req.headers.origin !== origin || (site !== undefined && site !== "same-origin")) return no(403, "origin", "Only the page itself may send input.");
		const file = scope === "sessions" && action === "upload";
		if (type !== (file ? "application/octet-stream" : "application/json")) return no(415, "content_type", file ? "The body must be the file's bytes." : "The body must be JSON.");
		if (!same(String(req.headers["x-sb-csrf"] ?? ""), csrf)) return no(403, "csrf", "The page's token is out of date; reload the page.");
		if (file) {
			// A box's unit takes the file through its session: at most 2 MB (decision 11), held in memory, then sent sealed.
			const far = bridge?.claim("POST", ["sessions", key, "upload"], {}, new URLSearchParams({ name: String(req.headers["x-sb-name"] ?? "") })); // the file's name travels in the query, as the box reads it
			if (far) {
				const bytes = await bytesOf(req, MAX_REMOTE_UPLOAD);
				return Buffer.isBuffer(bytes) ? far.send(bytes) : bytes;
			}
			return upload(req, lookup(key)); // its own size limit and reader (upload.ts)
		}
		const read = await body(req);
		if ("status" in read) return read;
		return run([scope, key, action], read.json, { remote, secure: origin.startsWith("https:") });
	}

	/**
	 * One request past the HTTP shell: the session checks, then one Herdr call. Everything a guard decides is decided here, so a request that does not come over HTTP (an operate session's, gui.ts `operate`) meets the very guards a paired
	 * device does; `operate` adds the box's own (docs/specs/2026-11-07-link-operate.md §7), which the table of operateroutes.ts has already applied to the route and the text.
	 */
	async function run([scope, key = "", action = ""]: string[], json: Record<string, unknown>, { remote, secure, operate, foreground, alive }: Flags): Promise<Reply> {
		// A unit of a box this computer operates (operatehost.ts): the guards that belong to this end come first (the composer's text as a paired device's, a secret never from a page), and the box runs its own again (§7).
		// A chat block's answer (gui/blockanswer.ts) is recorded as answered in the very request that sends it, a box's unit included (the record is this server's).
		if (answered && !operate && scope === "sessions" && action === "input" && json.block !== undefined) return recordBlock(answered, key, json, (rest) => run([scope, key, action], rest, { remote, secure, operate, foreground }));
		const far = !operate ? bridge?.claim("POST", [scope, key, action].slice(0, action ? 3 : key ? 2 : 1), json) : undefined;
		if (far) {
			if (scope === "sessions" && action === "input") {
				const text = checkText(json.text);
				if (typeof text !== "string") return text;
				if (remote && localOnlyText(text)) return no(403, "local_only", LOCAL_ONLY);
			}
			if (scope === "sessions" && action === "answer" && "value" in json) return no(secure ? 403 : 400, secure ? "local_only" : "terminal_only", "A secret cannot be entered from a page; answer it in the terminal.");
			return far.send();
		}
		if (scope === "server") {
			if (panel && !action && key === "status") return { status: 200, body: panel.status() };
			if (panel && !action && key === "log") {
				const lines = json.lines === undefined ? 200 : json.lines;
				return Number.isInteger(lines) && (lines as number) >= 1 && (lines as number) <= 200 ? { status: 200, body: { lines: panel.log(lines as number) } } : no(400, "bad_request", "Ask for 1 to 200 lines.");
			}
			if (panel && !action && key === "restart") {
				const reason = json.reason === undefined || json.reason === "" ? "from the GUI" : json.reason;
				return typeof reason === "string" && reason.length <= 200 && !/[\r\n]/.test(reason) ? panel.restart(reason) : no(400, "bad_request", "A reason is one line of at most 200 characters.");
			}
			const { by, take } = json;
			if (key !== "stop" || action || !stop) return no(404, "not_found", "No such action.");
			return typeof by === "string" && by.length <= 200 && typeof take === "boolean" ? (stop({ by, take }) === false ? no(409, "refused", "This server is not taken over.") : { status: 202, body: { stopping: true } }) : no(400, "bad_request", "A stop names who asks.");
		}
		if (scope === "auto") {
			if (!auto) return no(503, "unavailable", "This server has no auto mode.");
			if (operate) return no(403, "local_only", "Auto mode is switched at the computer or on a paired phone, never from a box.");
			if (!key && !action) return typeof json.on === "boolean" ? auto.set(json.on, remote) : json.on === undefined ? auto.state() : no(400, "bad_request", "on is true or false.");
			return key === "report" && !action ? auto.report() : key === "confirm" && !action ? auto.confirm(json.id, remote) : no(404, "not_found", "No such action.");
		}
		if (scope === "board") return board && key === "clear" && !action ? board.clear(json) : no(board ? 404 : 503, board ? "not_found" : "unavailable", board ? "No such action." : "This server shows no work board.");
		if (scope === "doc") return docs && action === "answer" ? docs.answer(key, json) : no(docs ? 404 : 503, docs ? "not_found" : "unavailable", docs ? "No such action." : "This server shows no documents.");
		if (scope === "trust") return trust && key === "answer" && !action ? trust(json) : no(trust ? 404 : 503, trust ? "not_found" : "unavailable", trust ? "No such action." : "This server takes no trust answers.");
		if (scope === "link") {
			if (!link) return no(503, "unavailable", "This server has no Straw Link.");
			if (!LINK_NAMES.includes(key) || action) return no(404, "not_found", "No such action.");
			if (remote && !REMOTE_LINK.includes(key)) return no(403, "local_only", "Straw Link's team settings are changed on this computer's own page.");
			if (key === "enable") return link.enable().then(() => ({ status: 200, body: {} }), (error: Error) => no(502, "link_failed", error.message));
			const done = await link.call(key, json);
			if (!done.ok) return no(409, done.code ?? "link_failed", done.error ?? "Straw Link refused it.");
			const { ok: _ok, ...body } = done;
			// An invite is drawn as a QR on the page: the rows come from the text the holder made, which never travels any other way.
			if (typeof body.text === "string" && (key === "invite" || key === "invite-text")) body.rows = qr(body.text).map((row) => row.map(Number).join(""));
			// A paired device reads the state without what an agent's request put in the join or create screen (an invite text is a credential).
			const view = body.view as { prefill?: { text?: string } } | undefined;
			if (remote && view?.prefill) delete view.prefill.text;
			return { status: 200, body };
		}
		if (scope === "panes") return panes({ grants, mirrors, pad, call, busy, refused }, key, action, json, remote);
		if (remote && json.op === "press" && json.act === "secret" && ((scope === "tower" && action === "memory") || (scope === "head" && key === "memory"))) return no(409, "refused", "Enter it at the computer: this step is taken on this computer's own page or in pi."); // WC-D4: a secret card's first step says the boss is at this computer, so only its own page (or pi) takes it
		if (scope === "tower") {
			if (key.startsWith("@") || tower?.isHead?.(key)) return no(404, "not_found", "No such tower.");
			// A headless run's dialog and the viewer tab are this computer's own (docs/specs/2026-11-23-f-entry.md §5): a paired device and a box's controller never get an approval card (`NO_RELAY`), and a tab opens where the boss sits.
			if (action === "dialog" || action === "viewer") return runRoute(tower, key, action, json, Boolean(remote || operate));
			if (action === "memory") return tower?.memory && tower.has(key) ? tower.memory(key, json, operate ? "box" : remote ? "phone" : "gui") : no(404, "not_found", "No such tower.");
			if (action === "leave" || action === "new") {
				if (!tower?.conversation || !tower.has(key)) return no(404, "not_found", "No such tower.");
				const done = await tower.conversation(key, action);
				return done.ok ? { status: 200, body: { ...(done.left !== undefined ? { left: done.left } : {}), ...(done.fresh ? { fresh: true } : {}) } } : no(409, "refused", done.error ?? "The tower refused it.");
			}
			const what = ["retry", "deliver", "drop"].find((w) => w === action);
			if (!tower || !what || !tower.has(key)) return no(404, "not_found", "No such tower.");
			const id = typeof json.id === "string" && json.id.length <= 64 ? json.id : undefined;
			if (what !== "retry" && !id) return no(400, "bad_request", "Name the parked event.");
			const done = await tower.act(key, what as "retry" | "deliver" | "drop", id);
			return done.ok ? { status: 200, body: {} } : no(409, "refused", done.error ?? "The tower refused it.");
		}
		// A tower unit of the sb server's service: the composer's Send is a boss event for its next run, and with no run live there is no terminal to key into or show.
		const unit = tower && scope === "sessions" ? lookup(key) : undefined, ws = unit?.role === "tower" && tower?.has(unit.base) ? unit.base : undefined;
		if (scope === "head" || unit?.role === "head") { const head = await headRoutes(tower, [scope, key, action], json, checkText, Boolean(remote || operate), operate ? "box" : remote ? "phone" : "gui"); if (head) return head; }
		if (tower && ws) {
			if (action === "input") {
				const text = checkText(json.text), answers = answersOf(json);
				if (typeof text !== "string") return text;
				if (typeof answers === "object") return answers;
				// The conversation's two commands, as at the tower prompt: exactly `/quit` leaves it and `/new` starts over (the Leave and New buttons post to tower/<ws>/leave and /new).
				const command = await commandReply(tower, ws, text, answers, "The tower refused it.");
				if (command) return command;
				const done = await tower.event(ws, text, remote || operate ? undefined : "page");
				return done.ok ? { status: 200, body: { accepted: true, woke: true, ...(answers ? await markAnswered(tower, ws, answers) : {}) } } : no(409, "refused", done.error ?? "The tower did not take it.");
			}
			if (action === "dequeue") return no(409, "server_queue", "These messages wait in the sb server's queue for the tower's next run; they are taken when it runs.");
			if (["keys", "mirror", "focus"].includes(action) && !tower.live(ws)) return no(409, "standing", "The tower is standing by: no run is live, so there is no terminal. Write to it in the composer; that wakes it.");
		}
		if (scope === "lan") {
			// Wi-Fi access changes who may command this computer: only its own page does it, and the gui.ts router has refused a paired device already (this is the second lock).
			if (remote) return no(403, "local_only", "Wi-Fi access is set on this computer's own page.");
			if (!lan || action) return no(lan ? 404 : 503, lan ? "not_found" : "unavailable", lan ? "No such action." : "This server serves no Wi-Fi access.");
			if (key === "on") return lan.on(json);
			if (key === "off") return lan.off();
			if (key === "pair") return lan.pair(json);
			if (key === "approve") return lan.approve(json);
			if (key === "ca") return lan.ca();
			return no(404, "not_found", "No such action.");
		}
		if (scope === "dismiss" && !key && json.all === true) return dismissAll ? { status: 200, body: { dismissed: await dismissAll() } } : no(503, "unavailable", "This server dismisses nothing.");
		if (scope === "dismiss" && !key) return (await dismiss?.(json.key)) ? { status: 200, body: {} } : no(404, "not_found", "Only a finished subagent on the net can be dismissed.");
		if (scope === "close") return close && !action ? close(key, json) : no(close ? 404 : 503, close ? "not_found" : "unavailable", close ? "No such action." : "This server closes nothing.");
		if (remote && scope === "open" && typeof json.prompt === "string" && localOnlyText(json.prompt)) return no(403, "local_only", LOCAL_ONLY);
		if (scope === "dirs" || scope === "open") return spawn && !action ? spawn([scope, key], json) : no(spawn ? 404 : 503, spawn ? "not_found" : "unavailable", spawn ? "No such action." : "This server opens nothing.");
		if (scope === "remote" && key === "on" && !action) {
			if (!remoteOn) return no(503, "unavailable", "This server cannot turn remote access on.");
			const failed = await remoteOn().then(() => undefined, (error: Error) => error.message);
			const unsaved = !failed && lost();
			if (unsaved) return unsaved;
			const paired = !failed && pair?.();
			return paired ? { status: 200, body: paired } : no(502, "remote_failed", failed ?? "Remote access did not turn on.");
		}
		if (scope === "remote" && !action && ["devices", "unpair", "unpair-all", "off"].includes(key)) {
			if (!paired) return no(503, "unavailable", "This server keeps no paired devices.");
			if (key === "devices") return { status: 200, body: { on: paired.on(), devices: paired.list() } };
			if (key === "off") return remoteOff ? remoteOff().then(() => lost() ?? { status: 200, body: {} }, (error: Error) => no(502, "remote_failed", error.message)) : no(503, "unavailable", "This server cannot turn remote access off.");
			if (key === "unpair-all") return ((n) => lost() ?? { status: 200, body: { unpaired: n } })(paired.unpairAll());
			const { id } = json;
			return typeof id !== "string" || !id || id.length > 64 ? no(400, "bad_request", "Name the device to unpair.") : paired.unpair(id) ? (lost() ?? { status: 200, body: {} }) : no(404, "not_found", "No such paired device.");
		}
		if (scope === "remote") {
			const pairing = key === "pair" && !action ? pair?.() : undefined;
			return pairing ? { status: 200, body: pairing } : key === "pair" && !action ? no(409, "remote_off", "Remote access is off.") : no(404, "not_found", "No such action.");
		}
		if (action === "mirror") return mirrors ? mirrors.toggle(key, json) : no(503, "unavailable", "This server shows no terminals.");
		if (!["input", "keys", "focus", "answer", "commands", "dequeue"].includes(action)) return no(404, "not_found", "No such action.");
		const found = lookup(key);
		if (!found) return no(404, "not_found", "No such session.");
		if (!found.live || !found.pane || !found.file) return no(409, "not_live", "This session is no longer live in a pane.");
		if (action === "commands") { // a read: no Herdr call, and it never waits for or blocks a send
			const { prefix } = json;
			if (typeof prefix !== "string" || prefix.length > MAX_PREFIX || /\s/.test(prefix)) return no(400, "bad_request", "A prefix is the start of a command name.");
			return { status: 200, body: { commands: (await answers?.commands(key, prefix)) ?? null } };
		}
		if (!call) return no(503, "unavailable", "This server cannot reach Herdr.");
		let job: () => Promise<unknown>, direct: Reply | undefined;
		if (action === "input") {
			const text = checkText(json.text);
			if (typeof text !== "string") return text;
			if (json.as !== "send" && json.as !== "followUp") return no(400, "bad_request", "`as` must be send or followUp.");
			// `/boss send` posts from this computer on a paired device's behalf (it may have typed the command), so it says `guarded` and meets the guards a paired device's own write meets.
			const guarded = remote || json.guarded === true;
			if (guarded && localOnlyText(text)) return no(403, "local_only", remote ? LOCAL_ONLY : GUARDED);
			if (ENDING.test(text) && json.confirmed !== true) return no(409, "confirm", "This command ends or replaces the session; confirm to send it.");
			job = async () => {
				const pane = await live(found);
				if (operate) { // the text joins whatever draft the editor holds (pasted at the cursor, then Enter), so it goes only into an empty one (probe.ts)
					const e = await answers?.probe(key, undefined, true);
					// and the Enter it ends with (agent.prompt's, or the Alt+Enter of a follow-up while it works) is a key write like the pad's: its binding must be the editor's
					const barred = operateTextRefusal(e) ?? operateKeyRefusal(e, json.as === "followUp" && pane.agent_status === "working" ? "alt+enter" : "enter");
					if (barred) throw no(403, OPERATE_REFUSED, barred.reason, { why: barred.why });
				}
				if (guarded && (await requested(key, found))) throw no(403, "local_only", remote ? LINK_LOCAL : GUARDED); // a prompt's Enter would be taken by its terminal dialog as Yes
				if (pane.agent_status === "blocked") throw no(409, "blocked", "It is waiting on a dialog; answer it in the terminal.");
				if (guarded) guardOverlay(found, remote); // right before the write: the composer's text and Enter would answer the overlay
				if (operate) await foremost(foreground, pane.pane_id, key, alive);
				// Enter sends a prompt when idle and a steering message while it works; Alt+Enter queues a follow-up, which only means something while it works.
				return json.as === "followUp" && pane.agent_status === "working"
					? call("pane.send_input", { pane_id: pane.pane_id, text, keys: ["alt+enter"] }, 15_000)
					: call("agent.prompt", { target: pane.pane_id, text }, 15_000);
			};
		} else if (action === "keys") {
			if (busy.has(key)) return no(429, "busy", "Another input to this session is still on its way.");
			const asked = pad.check(key, json, remote, operate === true);
			if ("status" in asked) return asked;
			job = async () => {
				const plan = await pad.send(key, found, await live(found), asked);
				if (asked.key === "enter") await live(found); // the editor check took up to 4 s (dialogs.ts): still pi, on this file
				// A link_request's call may have opened since the guard looked; its terminal confirm takes Enter as Yes, so look again right before each write.
				for (const [i, [method, params]] of plan.calls.entries()) {
					if (i) await new Promise((r) => setTimeout(r, 60));
					if (remote && asked.key !== "esc" && (await requested(key, found))) throw no(403, "local_only", LINK_LOCAL);
					if (remote && asked.key !== "esc") guardOverlay(found); // and the overlay's mark, looked at last with nothing awaited before the write
					if (operate) await foremost(foreground, found.pane!, key, alive); // and, for an operate session, pi's hold of the terminal
					await call(method, params, 15_000);
				}
				pad.sent(key, plan);
			};
		} else if (action === "dequeue") {
			const { take } = json;
			if (typeof take !== "string" || !ANSWER_ID.test(take)) return no(400, "bad_request", "Name this take-back by an id the page made.");
			if (!answers) return no(503, "unavailable", "This server cannot reach the session's bridge.");
			job = async () => {
				const pane = await live(found);
				if (pane.agent_status === "blocked") throw no(409, "blocked", "It is waiting on a dialog; answer it in the terminal.");
				const begun = await answers.pull(key, "begin", take);
				if (!begun) throw no(504, "unsure", "The session did not answer; nothing was taken back. Its pi-straw-boss may be too old for this.");
				if (begun.reason) throw no(409, begun.reason, PULL_WHY[begun.reason]!);
				if (begun.text !== undefined) return void (direct = { status: 200, body: { text: begun.text } }); // this very take-back was done, and its answer got lost on the way: no key goes
				if (!begun.pending || !begun.ticket) return void (direct = { status: 200, body: { empty: true } }); // nothing is queued: no key goes
				const sent = begun.key ?? defaultDequeue(); // a bridge that names no key is an older pi-straw-boss: pi's default on this platform
				if (operate) { // the key goes into whatever has the terminal: pi's raw mode, told by the bridge, is the proof that it is pi's editor
					const barred = operateRawRefusal(await answers.probe(key, undefined, true));
					if (barred) throw no(403, OPERATE_REFUSED, barred.reason, { why: barred.why });
				}
				const plan = await pad.dequeue(key, found, pane, sent, remote);
				await live(found); // the guard took a moment: still pi, on this file
				for (const [method, params] of plan.calls) {
					if (remote && (await requested(key, found))) throw no(403, "local_only", LINK_LOCAL); // as in keys: a link_request may have opened since the guard looked
					if (remote) guardOverlay(found);
					if (operate) await foremost(foreground, found.pane!, key, alive);
					await call(method, params, 15_000);
				}
				const done = await answers.pull(key, "finish", begun.ticket);
				if (!done) throw no(504, "unsure", "The session did not answer in time. The messages are in the terminal's editor, or the session keeps them for a few minutes: use Fetch again on the page to get them.");
				if (done.reason) throw no(409, done.reason, done.reason === "not_taken" ? notTaken(sent) : PULL_WHY[done.reason]!, done.reason === "not_taken" ? { key: sent, label: keyLabel(sent) } : {});
				direct = done.text !== undefined ? { status: 200, body: { text: done.text } } : { status: 200, body: { empty: true } }; // empty: delivered between the check and the key
			};
		} else if (action === "answer") {
			const { dialog, digest, answerId } = json;
			if (typeof dialog !== "string" || dialog.length > 64 || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest) || typeof answerId !== "string" || !ANSWER_ID.test(answerId)) return no(400, "bad_request", "The answer does not name its dialog.");
			if (!answers) return no(503, "unavailable", "This server takes no answers.");
			if ("value" in json) return no(secure ? 403 : 400, secure ? "local_only" : "terminal_only", "A secret cannot be entered from a page; answer it in the terminal."); // from no page (SB-F001): nothing of it is read, kept, or looked up
			const known = answers.replay(answerId, key); // the same answer sent again (Check again) gets the outcome it had
			if (known) return known;
			job = async () => {
				const at = await live(found);
				const target = await answers.target(key), ended = answers.ended(key, dialog, answerId); // answered in the terminal a moment ago, or by this very answer
				if (target?.answer.dialog !== dialog || target.answer.digest !== digest) throw ended ?? no(409, "changed", "The question changed or is no longer open here; read it again.");
				const checked = checkAnswer(target.answer, json);
				if (typeof checked === "string") throw no(400, "bad_answer", checked);
				if (remote && "choice" in checked && target.answer.select?.choices[checked.choice]?.hereOnly) throw no(403, "local_only", "This choice is approved on this computer's own page or terminal; a paired device can only deny."); // decided by the listener and the stored dialog, never the body
				if (remote && "cancel" in checked && target.answer.select?.choices.every((c) => c.hereOnly)) throw no(403, "local_only", "This dialog is answered on this computer's own page or terminal; a paired device cannot cancel it."); // cancelling is a refusal: a paired device may where it may pick some choice (a link approval's Deny), not where every choice is this computer's
				// A choice that leaves a step in a terminal (its `next`, from the stored dialog): the panes of the tab are noted before the answer goes out, so the one it opens can be told after.
				const picked = "choice" in checked ? target.answer.select?.choices[checked.choice] : undefined, next = picked?.next, tag = picked?.tagged ? answerId : undefined;
				if (operate && next === "pane") throw no(403, OPERATE_REFUSED, "An answer that opens a pane (it runs a shell) is not given from here.", { why: "route" }); // decision 8: nothing of a pane crosses
				const noted = next === "pane" ? await grants?.before(at.pane_id) : undefined;
				const sent = await answers.send(key, target, { id: dialog, answerId, digest, ...checked });
				if (sent.body.outcome === "accepted" && next) sent.body.then = await thenOf(grants, next, key, at.pane_id, noted, tag); // on the stored object, so Check again replays it with the same `then`
				// The command the answer put in the prompt may run in one tap (runs.ts): the page is told, and the grant waits for its Enter.
				if (sent.body.outcome === "accepted" && next === "terminal" && runs.issue(key, answerId, target.answer.select?.copy)) (sent.body.then as { run?: true }).run = true;
				return sent;
			};
		} else job = async () => call("agent.focus", { target: (await live(found)).pane_id });
		if (busy.has(key)) return no(429, "busy", "Another input to this session is still on its way.");
		busy.add(key);
		try {
			const sent = (await job()) as Sent | undefined;
			return direct ?? (sent?.body?.outcome ? sent : { status: 200, body: { accepted: true } });
		} catch (error) {
			return (error as Reply).status ? (error as Reply) : refused(error);
		} finally {
			busy.delete(key);
		}
	}
	return Object.assign(handle, { run });

	/** A paired device's write is about to go to `found`'s pane: refused while a `/boss gui lan` face holds a mark on it, else noted (a face that opens within 1.5 s refuses its own answers after it). Nothing is awaited between this and the Herdr call. */
	function guardOverlay(found: Found, remote = true) {
		if (!overlay) return;
		if (overlay.marked(found.pane)) throw no(409, "lan_overlay_open", remote ? OVERLAY_OPEN : GUARDED);
		overlay.wrote(found.pane);
	}
	/** The pane as Herdr has it now: it must still run pi, on this session's file. */
	async function live(found: Found): Promise<Pane> {
		const { pane } = (await call!("pane.get", { pane_id: found.pane })) as { pane: Pane };
		if (pane.agent !== "pi") throw no(409, "not_pi", "The pane no longer runs pi.");
		if (canonical(pane.agent_session?.value) !== found.file) throw no(409, "moved", "The pane moved to another session.");
		return pane;
	}
}
