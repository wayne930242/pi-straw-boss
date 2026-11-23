import type { TowerService } from "../src/net.ts";
import { BOSS_MARK, CRASH_FLAG, eventMarker } from "../src/eventmarks.ts";
import { m } from "./sentences.ts";
import type { Answer } from "./post.ts";
import { actionWhy } from "./towermodel.ts";
import { operateWhy } from "./termwords.ts";

// What the session view says about a tower the sb server runs, apart from the map (towermodel.ts): the turns of a run that the server wrote, what a refused send was, and what stands where a terminal would be. The view's own chunk loads it.

type Opts = { locale?: "en" | "zh-TW" };
export { bossTurn } from "../src/eventmarks.ts";

/**
 * A user turn in a tower's run that the server wrote, not the boss: the first line is the server's (src/runmode.ts `eventText`), written from the broker's sender and cleaned, so only it is read. The boss's
 * own turn opens with another marker and stays the boss's.
 */
export function heard(text: string | undefined): { kind: "intercom"; from: string } | { kind: "server" | "timer" } | undefined {
	const first = eventMarker((text ?? "").split("\n", 1)[0]);
	if (first.startsWith("[intercom from ") && first.endsWith("]")) return { kind: "intercom", from: first.slice("[intercom from ".length, -1) };
	if (first === "[notice from the sb server]") return { kind: "server" };
	if (first === "[your wakeAfter follow-up is due]") return { kind: "timer" };
}

/** The sender of an intercom marker line (`label (id)`, `(id)`, or the words for none) as its name and id; the line is the server's, written from the broker's sender and cleaned, so the id is the session's own. */
export function senderOf(from: string | undefined): { name: string; id?: string } {
	const text = (from ?? "").trim(), at = /^(.*?)\s*\(([^()]*)\)$/.exec(text);
	return at ? { name: at[1]!, ...(at[2] ? { id: at[2] } : {}) } : { name: text };
}

/** A header the code writes (src/header.ts) and the text under it: its fields as written, the line itself, and the peer's text. Undefined for a message that does not open with one, or whose line does not close. */
export function strawHeader(text: string | undefined): { fields: Record<string, string>; raw: string; body: string } | undefined {
	const t = text ?? "", open = "[straw net ";
	if (!t.startsWith(open)) return undefined;
	const fields: Record<string, string> = {};
	let i = open.length;
	for (;;) {
		while (t[i] === " ") i++;
		if (t[i] === "]") break;
		const eq = t.indexOf("=", i);
		if (eq < 0 || !/^[a-z]+$/.test(t.slice(i, eq))) return undefined;
		const key = t.slice(i, eq);
		let end: number;
		if (t[eq + 1] === '"') {
			end = t.indexOf('"', eq + 2);
			if (end < 0) return undefined;
			fields[key] = t.slice(eq + 2, end++);
		} else {
			end = eq + 1;
			while (end < t.length && t[end] !== " " && t[end] !== "]") end++;
			fields[key] = t.slice(eq + 1, end);
		}
		i = end;
	}
	return { fields, raw: t.slice(0, i + 1), body: t.slice(i + 1).replace(/^ /, "") };
}

/** One event of a tower's run as the comms say it: who it is from and what it carried, with the server's marker lines (and the crash flag after them) taken off. */
export type Turn = { kind: "boss" | "intercom" | "server" | "timer"; body: string; crashed: boolean; from?: string } | { kind: "link"; what: "ask" | "reply" | "answer" | "message"; from: string; body: string; raw?: string };
const MARKS = { intercom: (l: string) => l.startsWith("[intercom from ") && l.endsWith("]"), notice: (l: string) => l === "[notice from the sb server]", timer: (l: string) => l === "[your wakeAfter follow-up is due]" };

/**
 * The turn a tower-run message is, by what the server sent it as (`event`, src/items.ts from `details.kind`): the text can say anything, so only the kind the server recorded makes a message the boss's.
 * A `straw-tower` event of a kind this page does not know, and any other message, give undefined (the generic notice). A link message is cut at the verified header, which stays whole for the details.
 */
export function eventTurn(it: { type?: string; event?: string; text?: string; from?: string }): Turn | undefined {
	const text = it.text ?? "";
	if (it.type === "straw-link" || it.event === "link") {
		const head = strawHeader(text), kind = head?.fields.kind, from = it.from ?? head?.fields.remote ?? head?.fields.from ?? "?";
		const what = kind === "link_reply" ? "reply" : kind === "tower_reply" ? "answer" : head?.fields.asks ? "ask" : "message";
		return { kind: "link", what, from, body: head ? head.body : text, ...(head ? { raw: head.raw } : {}) };
	}
	if (it.type !== "straw-tower") return undefined;
	if (it.event === "steer") return { kind: "server", body: text.replace(/^\[sb server\] /, ""), crashed: false };
	const lines = text.split("\n"), marker = eventMarker(lines[0]), strip = (marked: boolean) => {
		const crashed = marked && lines[1] === CRASH_FLAG;
		return { body: marked ? lines.slice(crashed ? 2 : 1).join("\n") : text, crashed };
	};
	switch (it.event) {
		case "boss": return { kind: "boss", ...strip(marker === BOSS_MARK) };
		case "intercom": {
			const marked = MARKS.intercom(marker);
			return { kind: "intercom", from: marked ? marker.slice("[intercom from ".length, -1) : (it.from ?? ""), ...strip(marked) };
		}
		case "notice": return { kind: "server", ...strip(MARKS.notice(marker)) };
		case "timer": return { kind: "timer", ...strip(MARKS.timer(marker)) };
	}
}

/** What the tower, or an operate box, refused to a send, in the page's language: by the code the page's server gives, else by the reasons it is known to give; undefined for any other (the server's own words stay). */
export function towerWhy(r: Pick<Answer, "status" | "body">, o?: Opts): string | undefined {
	if (r.status < 400) return undefined;
	if (r.body.error === "standing") return m.tower_err_standing({}, o);
	if (r.body.error === "server_queue") return m.tower_err_server_queue({}, o);
	if (r.body.error === "too_large") return m.too_long({}, o);
	if (r.body.error === "control_character") return m.tower_err_control({}, o);
	if (r.body.error === "not_an_answer") return m.tower_err_not_an_answer({}, o);
	if (r.body.error === "operate_refused") return operateWhy(r, o?.locale);
	return actionWhy(r, o);
}

/** The sentence that stands where a terminal would be, for a tower with no run live (the server answers its keys and mirror with 409 `standing`); undefined when it has one. */
export function termHold(service: TowerService | undefined, o?: Opts): string | undefined {
	// Headless runs have no pane: the Terminal tab mirrors a viewer when one runs, else it says where the runs show (docs/specs/2026-11-23-lite-b2-d-e-f.md §4.4, The GUI).
	if (service?.headless) return service.viewer ? undefined : m.tower_term_headless({}, o);
	if (!service || service.run) return undefined;
	return service.state === "held" ? m.tower_term_held({}, o) : m.tower_term_standing({}, o);
}
