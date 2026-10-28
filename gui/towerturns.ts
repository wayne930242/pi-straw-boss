import type { TowerService } from "../src/net.ts";
import { BOSS_MARK, CRASH_FLAG } from "../src/eventmarks.ts";
import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";
import { actionWhy } from "./towermodel.ts";

// What the session view says about a tower the sb server runs, apart from the map (towermodel.ts): the turns of a run that the server wrote, what a refused send was, and what stands where a terminal would be. The view's own chunk loads it.

type Opts = { locale?: "en" | "zh-TW" };

/**
 * A user turn in a tower's run that the server wrote, not the boss: the first line is the server's (src/runmode.ts `eventText`), written from the broker's sender and cleaned, so only it is read. The boss's
 * own turn opens with another marker and stays the boss's.
 */
export function heard(text: string | undefined): { kind: "intercom"; from: string } | { kind: "server" | "timer" } | undefined {
	const first = (text ?? "").split("\n", 1)[0]!;
	if (first.startsWith("[intercom from ") && first.endsWith("]")) return { kind: "intercom", from: first.slice("[intercom from ".length, -1) };
	if (first === "[notice from the sb server]") return { kind: "server" };
	if (first === "[your wakeAfter follow-up is due]") return { kind: "timer" };
}

/** The boss's own turn in a service tower's run: its marker line (and the crash flag line after it) is the server's, so the bubble shows what the boss wrote, with the flag as a note; undefined for any other turn. */
export function bossTurn(text: string | undefined): { body: string; crashed: boolean } | undefined {
	const lines = (text ?? "").split("\n");
	if (lines[0] !== BOSS_MARK) return undefined;
	const crashed = lines[1] === CRASH_FLAG;
	return { body: lines.slice(crashed ? 2 : 1).join("\n"), crashed };
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
	const text = it.text ?? "", strip = (ok: (line: string) => boolean) => {
		const lines = text.split("\n"), marked = ok(lines[0] ?? "") ? 1 : 0, crashed = marked === 1 && lines[1] === CRASH_FLAG;
		return { body: lines.slice(marked + (crashed ? 1 : 0)).join("\n"), crashed };
	};
	if (it.type === "straw-link" || it.event === "link") {
		const head = strawHeader(text), kind = head?.fields.kind, from = it.from ?? head?.fields.remote ?? head?.fields.from ?? "?";
		const what = kind === "link_reply" ? "reply" : kind === "tower_reply" ? "answer" : head?.fields.asks ? "ask" : "message";
		return { kind: "link", what, from, body: head ? head.body : text, ...(head ? { raw: head.raw } : {}) };
	}
	if (it.type !== "straw-tower") return undefined;
	switch (it.event) {
		case "boss": return { kind: "boss", ...strip((l) => l === BOSS_MARK) };
		case "intercom": {
			const first = text.split("\n", 1)[0]!, marked = MARKS.intercom(first);
			return { kind: "intercom", from: marked ? first.slice("[intercom from ".length, -1) : (it.from ?? ""), ...strip(MARKS.intercom) };
		}
		case "notice": return { kind: "server", ...strip(MARKS.notice) };
		case "steer": return { kind: "server", body: text.replace(/^\[sb server\] /, ""), crashed: false };
		case "timer": return { kind: "timer", ...strip(MARKS.timer) };
	}
}

/** What the tower refused to a send, in the page's language: by the code the page's server gives, else by the reasons it is known to give; undefined for any other (the server's own words stay). */
export function towerWhy(r: Pick<Answer, "status" | "body">, o?: Opts): string | undefined {
	if (r.status < 400) return undefined;
	if (r.body.error === "standing") return m.tower_err_standing({}, o);
	if (r.body.error === "server_queue") return m.tower_err_server_queue({}, o);
	return actionWhy(r, o);
}

/** The sentence that stands where a terminal would be, for a tower with no run live (the server answers its keys and mirror with 409 `standing`); undefined when it has one. */
export function termHold(service: TowerService | undefined, o?: Opts): string | undefined {
	if (!service || service.run) return undefined;
	return service.state === "held" ? m.tower_term_held({}, o) : m.tower_term_standing({}, o);
}
