import type { Mark } from "../src/dashboard.ts";
import type { AllyBase, LinkAlert, LinkSummary } from "../src/link/holder.ts";
import { m } from "./paraglide/messages.js";

// What the page says about Straw Link, as plain functions of the holder's reading (src/link/holder.ts `LinkSummary`, `LinkView`): the notice texts,
// the countdown of an invite, a teammate's last presence, and how an ally base's states map onto the map's marks. No DOM here, so tests drive it.

const text = (v: string | number | undefined) => String(v ?? "");

/** A notice in words. `data` is the holder's: label, short id, tool, reason are a teammate's or the relay's text, so they only ever become text nodes. */
export function alertLine(a: LinkAlert): string {
	const d = a.data, team = a.teamName;
	switch (a.kind) {
		case "join-request": return d.unattended ? m.link_a_join_unattended({ label: text(d.label), short: text(d.short), team }) : m.link_a_join({ label: text(d.label), short: text(d.short), team });
		case "confirm": return m.link_a_confirm({ label: text(d.label), short: text(d.short), tool: text(d.tool) });
		case "fork": return m.link_a_fork({ team, reason: text(d.reason) });
		case "mismatch": return m.link_a_mismatch({ label: text(d.label), short: text(d.short), team });
		case "unreachable": return m.link_a_unreachable({ team, minutes: text(d.minutes) });
		case "inbox": return m.link_a_inbox({ count: text(d.count), team });
		case "held": return m.link_a_held({ count: text(d.count), team });
	}
}

/** The alerts that want the boss to act or look now (everything but a quiet inbox note), most urgent first. */
export const urgentFirst = (alerts: LinkAlert[]): LinkAlert[] => {
	const rank = { error: 0, warning: 1, info: 2 } as const;
	return [...alerts].sort((a, b) => rank[a.level] - rank[b.level]);
};

/** `m:ss` for what is left of an invite; `0:00` once it has lapsed. */
export function countdown(msLeft: number): string {
	const s = Math.max(0, Math.ceil(msLeft / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A teammate's last presence: online, or how long ago, or never seen since this computer started. */
export function lastSeen(ageMs: number | null, online: boolean): string {
	if (ageMs === null) return m.link_never_seen();
	if (online) return m.link_online();
	const n = Math.floor(ageMs / 1000);
	return m.link_seen_ago({ ago: n < 3600 ? m.age_m({ n: String(Math.max(1, Math.floor(n / 60))) }) : n < 86_400 ? m.age_h({ n: String(Math.floor(n / 3600)) }) : m.age_d({ n: String(Math.floor(n / 86_400)) }) });
}

/** An ally base's mark: offline is unknown (dim), a blocked tower waits on a question, working works, anything else idles. */
export function allyMark(a: Pick<AllyBase, "online" | "tower">): Mark {
	if (!a.online) return "unknown";
	return a.tower === "blocked" ? "waiting" : a.tower === "working" ? "working" : a.tower === "unknown" ? "unknown" : "idle";
}

/** What a tower state a teammate's presence reported reads as; one the page does not know is shown as it is (cut to the label character set by the sender's holder). */
export function stateName(state: string): string {
	switch (state) {
		case "working": return m.mark_working();
		case "blocked": return m.mark_waiting();
		case "idle": return m.mark_idle();
		case "done": return m.mark_done();
		case "unknown": return m.mark_unknown();
		default: return state;
	}
}

/** Whether the summary has anything to show in the HUD's Link button: a notice or a confirm. A quiet inbox note counts too, but a held message does not shout. */
export const hasLinkNews = (s: LinkSummary | undefined): boolean => Boolean(s && (s.alerts.length || s.confirms.length));
