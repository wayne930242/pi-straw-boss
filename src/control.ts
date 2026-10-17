import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { HerdrError, type HerdrCall, type Pane } from "./herdr.ts";
import type { Found } from "./net.ts";

// Typing into a session from the page, through Herdr's own input path only, as if typed in the terminal:
//   POST /<token>/api/sessions/<key>/input {text, as: "send" | "followUp", confirmed?}   the text, then Enter (or Alt+Enter while it works)
//   POST /<token>/api/sessions/<key>/keys  {keys}                                        keys from an allow list; never Ctrl+C or Ctrl+D
//   POST /<token>/api/sessions/<key>/focus                                               brings the session's pane forward in Herdr
//   POST /<token>/api/remote/pair                                                        a new one-time pairing URL and its QR, while remote access is on
// Every write needs the page's own origin (Origin, Sec-Fetch-Site), a JSON body of at most 64 KB, and the CSRF secret the server wrote into
// the page; the custom header forces a CORS preflight that is never approved. The key is resolved in the registry (paths and panes never come
// from the browser), and Herdr is asked right then that the pane still runs pi on that session's file, so a reused pane id is refused.
// One request per session is in flight at a time. Typed text is never logged; a Herdr timeout is not retried: it does not prove nothing arrived.

export const MAX_TEXT = 16_384, MAX_BODY = 65_536, MAX_KEYS = 16;
export const KEYS = new Set(["esc", "enter", "up", "down", "left", "right", "tab", "shift+tab", "space", "backspace", "pageup", "pagedown", "home", "end", "alt+up", "alt+o", "ctrl+g", ..."123456789"]);
/** Commands that end the session or switch its pane to another one: the page asks first, and the server refuses them unconfirmed. */
export const ENDING = /^\s*\/(quit|exit|new|resume|fork|clone|import|reload)(?=\s|$)/;
// Control characters would act as keys inside the paste (ESC[201~ ends it, after which anything is raw input, Ctrl+C included); tab and newline stay.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

export interface Reply { status: number; body: unknown }
export interface ControlDeps { lookup(key: string): Found | undefined; call?: HerdrCall; csrf: string; canonical(file?: string): string | undefined; pair?(): { url: string; rows: string[] } | undefined }

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
	if (CONTROL.test(typed)) return no(400, "control_character", "Control characters cannot be typed from the browser.");
	return typed;
}

export function createControl({ lookup, call, csrf, canonical, pair }: ControlDeps) {
	const busy = new Set<string>();
	/** The origin checks, then the session checks, then one Herdr call. `parts` is the path after api/: sessions/<key>/<action>, or remote/pair. */
	return async function handle(req: IncomingMessage, origin: string, [scope, key = "", action = ""]: string[]): Promise<Reply> {
		if (req.method !== "POST") return no(405, "method", "Use POST.");
		const site = req.headers["sec-fetch-site"], type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
		if (req.headers.origin !== origin || (site !== undefined && site !== "same-origin")) return no(403, "origin", "Only the page itself may send input.");
		if (type !== "application/json") return no(415, "content_type", "The body must be JSON.");
		if (!same(String(req.headers["x-sb-csrf"] ?? ""), csrf)) return no(403, "csrf", "The page's token is out of date; reload the page.");
		const read = await body(req);
		if ("status" in read) return read;
		if (scope === "remote") {
			const paired = key === "pair" && !action ? pair?.() : undefined;
			return paired ? { status: 200, body: paired } : key === "pair" && !action ? no(409, "remote_off", "Remote access is off; turn it on with /boss gui remote.") : no(404, "not_found", "No such action.");
		}
		if (!["input", "keys", "focus"].includes(action)) return no(404, "not_found", "No such action.");
		const found = lookup(key);
		if (!found) return no(404, "not_found", "No such session.");
		if (!found.live || !found.pane || !found.file) return no(409, "not_live", "This session is no longer live in a pane.");
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
			const keys = json.keys;
			if (!Array.isArray(keys) || !keys.length || keys.length > MAX_KEYS || !keys.every((k) => typeof k === "string" && KEYS.has(k))) return no(400, "key", "Only keys from the allow list can be sent (never Ctrl+C or Ctrl+D).");
			job = async () => {
				const pane = await live(found);
				// A dialog may be a masked secret prompt; until the page can tell which (phase 3), only Escape reaches a waiting session.
				if (pane.agent_status === "blocked" && keys.some((k) => k !== "esc")) throw no(409, "blocked", "While it waits on a dialog only Escape is sent from the browser; answer it in the terminal.");
				return call("pane.send_input", { pane_id: pane.pane_id, keys }, 15_000);
			};
		} else job = async () => call("agent.focus", { target: (await live(found)).pane_id });
		if (busy.has(key)) return no(429, "busy", "Another input to this session is still on its way.");
		busy.add(key);
		try {
			await job();
			return { status: 200, body: { accepted: true } };
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
