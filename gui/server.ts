import { h } from "./dom.ts";
import type { Tile } from "./layer.ts";
import { m } from "./paraglide/messages.js";
import { post } from "./post.ts";

// The sb server's panel, its own small chunk (this computer's page only: the server answers 403 local_only on the remote listener, and the button is hidden there). It shows the server's
// state, version, uptime, and last error; Restart server asks for an optional reason and confirms that the page's address is replaced (the new server's GUI has a token of its own, so this page is not reconnected); Show log reads the last 200 lines.

interface Status { state?: string; version?: string; pid?: number; uptimeMs?: number; lastError?: { at: string; code: string; text: string } }
const uptime = (ms: number) => (ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)} h ${Math.floor((ms % 3_600_000) / 60_000)} min` : ms >= 60_000 ? `${Math.floor(ms / 60_000)} min` : `${Math.floor(ms / 1000)} s`);

export function serverTile(): Tile {
	return { id: "server", title: m.server_tile(), body: () => {
		const facts = h("dl", { class: "server-facts" }), note = h("p", { class: "chat-empty", role: "status" }), log = h("pre", { class: "link-args" });
		const reason = h("input", { type: "text", maxlength: "200", placeholder: m.server_reason(), "aria-label": m.server_reason() });
		const restart = h("button", { type: "button", class: "pair-btn" }, m.server_restart()), show = h("button", { type: "button", class: "later" }, m.server_log());
		log.hidden = true;
		const row = (name: string, value: string) => [h("dt", null, name), h("dd", null, value)];
		async function refresh(): Promise<boolean> {
			const r = await post("server/status", {}).catch(() => undefined);
			if (!r?.ok) return (facts.replaceChildren(), note.replaceChildren(r?.body.reason ?? m.no_answer()), false);
			const s = r.body as Status;
			facts.replaceChildren(...row(m.server_state(), s.state ?? "?"), ...row(m.server_version(), s.version ?? "?"), ...(typeof s.uptimeMs === "number" ? row(m.server_uptime(), uptime(s.uptimeMs)) : []), ...(s.lastError ? row(m.server_last_error(), `${s.lastError.code}: ${s.lastError.text}`) : []));
			return true;
		}
		// The first press asks to confirm in place (what the restart does to the page), the second restarts; Cancel puts the button back.
		const cancel = h("button", { type: "button", class: "later" }, m.server_cancel());
		cancel.hidden = true;
		let armed = false;
		cancel.onclick = () => ((armed = false), (restart.textContent = m.server_restart()), (cancel.hidden = true), note.replaceChildren());
		restart.onclick = () => {
			if (!armed) return ((armed = true), (restart.textContent = m.server_restart_yes()), (cancel.hidden = false), note.replaceChildren(m.server_restart_confirm()));
			armed = false;
			cancel.hidden = true;
			restart.textContent = m.server_restart();
			restart.disabled = true;
			note.replaceChildren(m.server_restarting());
			void post("server/restart", reason.value.trim() ? { reason: reason.value.trim() } : {}).then(async (r) => {
				if (!r.ok) return void note.replaceChildren(r.body.reason ?? m.refused({ status: r.status }));
				// The new server's GUI has a token of its own (RC3-F002): this address answers 403 from now on, so the panel does not wait for it; the boss opens the new one.
				note.replaceChildren(m.server_restarted());
			}, () => note.replaceChildren(m.no_answer())).finally(() => (restart.disabled = false));
		};
		show.onclick = () => void post("server/log", { lines: 200 }).then((r) => {
			log.hidden = false;
			log.textContent = r.ok ? (r.body.lines as string[]).join("\n") || m.server_log_empty() : (r.body.reason ?? m.refused({ status: r.status }));
		}, () => ((log.hidden = false), (log.textContent = m.no_answer())));
		void refresh();
		return h("div", { class: "server" }, facts, h("div", { class: "devices-acts" }, reason, restart, cancel, show), note, log);
	} };
}
