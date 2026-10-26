import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { MAX_PREFIX } from "./commands.ts";
import { ANSWER_ID, checkAnswer, CONTROL, type Hub, type Sent, type Target } from "./dialogs.ts";
import { HerdrError, type HerdrCall, type Pane } from "./herdr.ts";
import { createKeys } from "./keys.ts";
import type { Asked } from "./gui.ts";
import type { createMirrors } from "./mirror.ts";
import type { Found } from "./net.ts";
import { upload } from "./upload.ts";
import { ENDING } from "./probe.ts";
import { qr } from "./qr.ts";

// Typing into a session from the page, through Herdr's own input path only, as if typed in the terminal:
//   POST /<token>/api/sessions/<key>/input {text, as: "send" | "followUp", confirmed?}   the text, then Enter (or Alt+Enter while it works)
//   POST /<token>/api/sessions/<key>/keys  {key, stream, confirmed?}                     one key pad key under its mirror (keys.ts), or Stop's {keys: ["esc"]}
//   POST /<token>/api/sessions/<key>/focus                                               brings the session's pane forward in Herdr
//   POST /<token>/api/sessions/<key>/commands {prefix}                                   its commands that match a typed `/prefix`, from its bridge (commands.ts); null when it did not say
//   POST /<token>/api/sessions/<key>/answer {dialog, digest, answerId, choice | answers}  answers its dialog through its bridge (dialogs.ts); no keys; a `value` (a secret) is refused from every page (SB-F001)
//   POST /<token>/api/sessions/<key>/upload (the file's bytes)                            stores a pasted, dropped, or picked file, answers its path (upload.ts)
//   POST /<token>/api/sessions/<key>/mirror {stream, on}                                  shows the pane's screen on that page's stream (mirror.ts), or stops
//   POST /<token>/api/remote/pair                                                        a new one-time pairing URL and its QR, while remote access is on (this computer only, never a paired device)
//   POST /<token>/api/remote/on, remote/off                                              turns remote access on in the server's session, then a pairing URL and its QR, or off (never remote)
//   POST /<token>/api/remote/devices, remote/unpair {id}, remote/unpair-all             the paired devices, and unpairing one or all (never remote)
//   POST /<token>/api/dismiss {key} or {all: true}                                       hides one finished subagent, or every finished one, from every page
//   POST /<token>/api/close/unit, close/tab, close/base                                   quits a session, or every agent of a squad or base, then closes it (closer.ts)
//   POST /<token>/api/close/stash {workspace, name}                                       checks and records a base, then closes it as close/base does (stash.ts); a paired device may, as it may close/base
//   POST /<token>/api/dirs, open/base, open/member, open/main                            a folder picker, a new base with a member, a new member, a new main (spawn.ts)
//   POST /<token>/api/link/<name> {…}                                                    Straw Link's team settings, through the link holder (link.ts of the page): state, create, invite, decide, join-start, trust, …
//                                                                                        This computer's page only, except `state` (without a pending invite's text) and `confirm-answer`, which a paired device may do like it answers any confirm
//   POST /<token>/api/server/stop {by, take}                                             stops the server: another session's /boss gui stop or takeover (never remote)
// Every write needs the page's own origin (Origin, Sec-Fetch-Site), a JSON body of at most 64 KB, and the CSRF secret the server wrote into
// the page; the custom header forces a CORS preflight that is never approved. The key is resolved in the registry (paths and panes never come
// from the browser), and Herdr is asked right then that the pane still runs pi on that session's file, so a reused pane id is refused.
// One request per session is in flight at a time. Typed text is never logged; a Herdr timeout is not retried: it does not prove nothing arrived.

export const MAX_TEXT = 16_384, MAX_BODY = 65_536;
export { ENDING };

export interface Reply { status: number; body: unknown }
/** The page's way to Straw Link's holder (runtime.ts `gui`): a named request with arguments, and the setup marker that starts the election before any team exists. */
export interface LinkPort { call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; error?: string; code?: string; [key: string]: unknown }>; enable(): Promise<void> }
/** What a paired device may ask: read the state, and answer a forwarded confirm. Everything else changes who may command this computer, so only its own page does it. */
const REMOTE_LINK = ["state", "confirm-answer"];
const LINK_NAMES = ["enable", "state", "create", "invite", "invite-text", "invite-cancel", "decide", "join-start", "join-project", "join-cancel", "prefill-clear", "remove", "role", "rotate", "trust", "leave", "confirm-answer"];
/** `answers.target` reads the net afresh, so the binding and the dialog are checked again for every answer. */
export interface ControlDeps { lookup(key: string): Found | undefined; call?: HerdrCall; csrf: string; canonical(file?: string): string | undefined; pair?(): { url: string; rows: string[] } | undefined; remoteOn?(): Promise<void>; remoteOff?(): Promise<void>; paired?: { on(): boolean; list(): unknown; unpair(id: string): boolean; unpairAll(): number; unsaved(): string | undefined }; saveFailed?(reason: string): void; spawn?(parts: string[], json: Record<string, unknown>): Promise<Reply>; close?(kind: string, json: Record<string, unknown>, refresh?: () => Promise<unknown>): Promise<Reply>; dismiss?(key: unknown): Promise<boolean>; dismissAll?(): Promise<number>; stop?(asked: Asked): void; link?: LinkPort; mirrors?: Pick<ReturnType<typeof createMirrors>, "toggle" | "fresh">; secret?(file: string): Promise<boolean>; answers?: Pick<Hub, "replay" | "ended" | "send" | "probe" | "commands"> & { target(key: string): Promise<Target | undefined> } }

const no = (status: number, error: string, reason: string): Reply => ({ status, body: { error, reason } });
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

/** Herdr's refusal as the page sees it; its own code is kept. */
function refused(error: unknown): Reply {
	const code = error instanceof HerdrError ? error.code : "herdr_error";
	if (code === "timeout") return no(504, code, "Herdr did not confirm it in time. Check the terminal before sending again.");
	if (["agent_blocked", "agent_not_found", "agent_not_ready", "pane_not_found"].includes(code)) return no(409, code, code === "agent_blocked" ? "It is waiting on a dialog; answer it in the terminal." : "The pane no longer runs this session.");
	return no(502, code, (error as Error).message);
}

/** The text as it will be typed, or why it cannot be: CRLF and lone CR become LF, then the size and character checks. */
export function checkText(text: unknown): string | Reply {
	if (typeof text !== "string" || !text.trim()) return no(400, "bad_request", "There is no text to send.");
	const typed = text.replace(/\r\n?/g, "\n");
	if (Buffer.byteLength(typed) > MAX_TEXT) return no(413, "too_large", "The text is longer than 16 KB.");
	if (CONTROL.test(typed)) return no(400, "control_character", "Control characters cannot be typed from the browser."); // they would act as keys inside the paste
	return typed;
}

export function createControl({ link, lookup, call, csrf, canonical, pair, remoteOn, remoteOff, paired, saveFailed, spawn, close, dismiss, dismissAll, stop, mirrors, secret = async () => true, answers }: ControlDeps) {
	const busy = new Set<string>();
	// A change to the paired devices or the remote wish that could not be written to paired.json took effect in memory only: say so (500), to the page and the session.
	const lost = (): Reply | undefined => {
		const reason = paired?.unsaved();
		return reason ? (saveFailed?.(reason), no(500, "save_failed", reason)) : undefined;
	};
	const pad = createKeys({ fresh: (id, key, pane) => mirrors?.fresh(id, key, pane) ?? false, secret, answerable: async (key) => Boolean(await answers?.target(key)), probe: async (key) => answers?.probe(key) });
	/** The origin checks, then the session checks, then one Herdr call. `parts` is the path after api/: sessions/<key>/<action>, remote/pair, or server/stop. */
	return async function handle(req: IncomingMessage, origin: string, [scope, key = "", action = ""]: string[], remote = false): Promise<Reply> {
		if (req.method !== "POST") return no(405, "method", "Use POST.");
		const site = req.headers["sec-fetch-site"], type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
		if (req.headers.origin !== origin || (site !== undefined && site !== "same-origin")) return no(403, "origin", "Only the page itself may send input.");
		const file = scope === "sessions" && action === "upload";
		if (type !== (file ? "application/octet-stream" : "application/json")) return no(415, "content_type", file ? "The body must be the file's bytes." : "The body must be JSON.");
		if (!same(String(req.headers["x-sb-csrf"] ?? ""), csrf)) return no(403, "csrf", "The page's token is out of date; reload the page.");
		if (file) return upload(req, lookup(key)); // its own size limit and reader (upload.ts)
		const read = await body(req);
		if ("status" in read) return read;
		if (scope === "server") {
			const { by, take } = read.json;
			if (key !== "stop" || action || !stop) return no(404, "not_found", "No such action.");
			return typeof by === "string" && by.length <= 200 && typeof take === "boolean" ? (stop({ by, take }), { status: 202, body: { stopping: true } }) : no(400, "bad_request", "A stop names who asks.");
		}
		if (scope === "link") {
			if (!link) return no(503, "unavailable", "This server has no Straw Link.");
			if (!LINK_NAMES.includes(key) || action) return no(404, "not_found", "No such action.");
			if (remote && !REMOTE_LINK.includes(key)) return no(403, "local_only", "Straw Link's team settings are changed on this computer's own page.");
			if (key === "enable") return link.enable().then(() => ({ status: 200, body: {} }), (error: Error) => no(502, "link_failed", error.message));
			const done = await link.call(key, read.json);
			if (!done.ok) return no(409, done.code ?? "link_failed", done.error ?? "Straw Link refused it.");
			const { ok: _ok, ...body } = done;
			// An invite is drawn as a QR on the page: the rows come from the text the holder made, which never travels any other way.
			if (typeof body.text === "string" && (key === "invite" || key === "invite-text")) body.rows = qr(body.text).map((row) => row.map(Number).join(""));
			// A paired device reads the state without what an agent's request put in the join or create screen (an invite text is a credential).
			const view = body.view as { prefill?: { text?: string } } | undefined;
			if (remote && view?.prefill) delete view.prefill.text;
			return { status: 200, body };
		}
		if (scope === "dismiss" && !key && read.json.all === true) return dismissAll ? { status: 200, body: { dismissed: await dismissAll() } } : no(503, "unavailable", "This server dismisses nothing.");
		if (scope === "dismiss" && !key) return (await dismiss?.(read.json.key)) ? { status: 200, body: {} } : no(404, "not_found", "Only a finished subagent on the net can be dismissed.");
		if (scope === "close") return close && !action ? close(key, read.json) : no(close ? 404 : 503, close ? "not_found" : "unavailable", close ? "No such action." : "This server closes nothing.");
		if (scope === "dirs" || scope === "open") return spawn && !action ? spawn([scope, key], read.json) : no(spawn ? 404 : 503, spawn ? "not_found" : "unavailable", spawn ? "No such action." : "This server opens nothing.");
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
			const { id } = read.json;
			return typeof id !== "string" || !id || id.length > 64 ? no(400, "bad_request", "Name the device to unpair.") : paired.unpair(id) ? (lost() ?? { status: 200, body: {} }) : no(404, "not_found", "No such paired device.");
		}
		if (scope === "remote") {
			const pairing = key === "pair" && !action ? pair?.() : undefined;
			return pairing ? { status: 200, body: pairing } : key === "pair" && !action ? no(409, "remote_off", "Remote access is off.") : no(404, "not_found", "No such action.");
		}
		if (action === "mirror") return mirrors ? mirrors.toggle(key, read.json) : no(503, "unavailable", "This server shows no terminals.");
		if (!["input", "keys", "focus", "answer", "commands"].includes(action)) return no(404, "not_found", "No such action.");
		const found = lookup(key);
		if (!found) return no(404, "not_found", "No such session.");
		if (!found.live || !found.pane || !found.file) return no(409, "not_live", "This session is no longer live in a pane.");
		if (action === "commands") { // a read: no Herdr call, and it never waits for or blocks a send
			const { prefix } = read.json;
			if (typeof prefix !== "string" || prefix.length > MAX_PREFIX || /\s/.test(prefix)) return no(400, "bad_request", "A prefix is the start of a command name.");
			return { status: 200, body: { commands: (await answers?.commands(key, prefix)) ?? null } };
		}
		if (!call) return no(503, "unavailable", "This server cannot reach Herdr.");
		const { json } = read;
		let job: () => Promise<unknown>;
		if (action === "input") {
			const text = checkText(json.text);
			if (typeof text !== "string") return text;
			if (json.as !== "send" && json.as !== "followUp") return no(400, "bad_request", "`as` must be send or followUp.");
			if (ENDING.test(text) && json.confirmed !== true) return no(409, "confirm", "This command ends or replaces the session; confirm to send it.");
			job = async () => {
				const pane = await live(found);
				if (pane.agent_status === "blocked") throw no(409, "blocked", "It is waiting on a dialog; answer it in the terminal.");
				// Enter sends a prompt when idle and a steering message while it works; Alt+Enter queues a follow-up, which only means something while it works.
				return json.as === "followUp" && pane.agent_status === "working"
					? call("pane.send_input", { pane_id: pane.pane_id, text, keys: ["alt+enter"] }, 15_000)
					: call("agent.prompt", { target: pane.pane_id, text }, 15_000);
			};
		} else if (action === "keys") {
			if (busy.has(key)) return no(429, "busy", "Another input to this session is still on its way.");
			const asked = pad.check(key, json);
			if ("status" in asked) return asked;
			job = async () => {
				const plan = await pad.send(key, found, await live(found), asked);
				if (asked.key === "enter") await live(found); // the editor check took up to a second: still pi, on this file
				for (const [i, [method, params]] of plan.calls.entries()) await (i ? new Promise((r) => setTimeout(r, 60)) : Promise.resolve()).then(() => call(method, params, 15_000));
				pad.sent(key, plan);
			};
		} else if (action === "answer") {
			const { dialog, digest, answerId } = json;
			if (typeof dialog !== "string" || dialog.length > 64 || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest) || typeof answerId !== "string" || !ANSWER_ID.test(answerId)) return no(400, "bad_request", "The answer does not name its dialog.");
			if (!answers) return no(503, "unavailable", "This server takes no answers.");
			if ("value" in json) return no(origin.startsWith("https:") ? 403 : 400, origin.startsWith("https:") ? "local_only" : "terminal_only", "A secret cannot be entered from a page; answer it in the terminal."); // from no page (SB-F001): nothing of it is read, kept, or looked up
			const known = answers.replay(answerId, key); // the same answer sent again (Check again) gets the outcome it had
			if (known) return known;
			job = async () => {
				await live(found);
				const target = await answers.target(key), ended = answers.ended(key, dialog, answerId); // answered in the terminal a moment ago, or by this very answer
				if (target?.answer.dialog !== dialog || target.answer.digest !== digest) throw ended ?? no(409, "changed", "The question changed or is no longer open here; read it again.");
				const checked = checkAnswer(target.answer, json);
				if (typeof checked === "string") throw no(400, "bad_answer", checked);
				return answers.send(key, target, { id: dialog, answerId, digest, ...checked });
			};
		} else job = async () => call("agent.focus", { target: (await live(found)).pane_id });
		if (busy.has(key)) return no(429, "busy", "Another input to this session is still on its way.");
		busy.add(key);
		try {
			const sent = (await job()) as Sent | undefined;
			return sent?.body?.outcome ? sent : { status: 200, body: { accepted: true } };
		} catch (error) {
			return (error as Reply).status ? (error as Reply) : refused(error);
		} finally {
			busy.delete(key);
		}
	};

	/** The pane as Herdr has it now: it must still run pi, on this session's file. */
	async function live(found: Found): Promise<Pane> {
		const { pane } = (await call!("pane.get", { pane_id: found.pane })) as { pane: Pane };
		if (pane.agent !== "pi") throw no(409, "not_pi", "The pane no longer runs pi.");
		if (canonical(pane.agent_session?.value) !== found.file) throw no(409, "moved", "The pane moved to another session.");
		return pane;
	}
}
