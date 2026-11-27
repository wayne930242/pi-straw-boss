import type { Base, BossWait } from "../src/net.ts";
import { waitSubject } from "../src/waitbudget.ts";
import { WAIT_FRESH_MS as FRESH_MS } from "../src/waitlapse.ts";
import type { Alert } from "./alerts.ts";
import { m } from "./sentences.ts";

// A wait the tower records on the boss (src/server/towermemory.ts `bossWaits`, docs/specs/2026-10-26-sb-backend.md, Tower memory, Waits) is a question for the boss: an alert of the tower while it is fresh, and on the tower card and in its
// comms for as long as it stands, with how long that has been and, after a day, that it may have settled. The pure parts are here: when it is fresh, how its age reads, the alerts of a snapshot.

type Opts = { locale?: "en" | "zh-TW" };
/** What an alert of a wait carries: the wait's id in the tower's memory and its text. */
export interface WaitInfo { id: string; text: string; /** A headless run's `boss_wait_ask` shows this card now (docs/specs/2026-11-24-zen-f.md ZF-3): the run's turn holds on it, so it blocks. */ asked?: true; /** The wait as the snapshot carries it (its card and press), for the card to draw. */ entry?: BossWait }
const age = (at: string, now: number) => now - Date.parse(at);

/** How long a wait has stood in the page's language (hours, then days); nothing under an hour or when the time cannot be read. */
export function waitAge(at: string, now: number, o?: Opts): string | undefined {
	const n = age(at, now) / 1000;
	return !(n >= 3600) ? undefined : n < 86_400 ? m.age_h({ n: String(Math.floor(n / 3600)) }, o) : m.age_d({ n: String(Math.floor(n / 86_400)) }, o);
}
/** The wait's line for the card and the comms: what it waits for (or that the boss answered it and the tower has not resolved it yet), how long it has, and that it may be out of date once it is a day old. */
export function waitLine(w: BossWait, now: number, o?: Opts): string {
	const since = waitAge(w.at, now, o);
	return [(w.answered ? m.tower_wait_answered : m.tower_waits_for_you)({ text: waitSubject(w) }, o), w.parked && m.wait_parked({}, o), since && m.tower_wait_age({ age: since }, o), age(w.at, now) >= FRESH_MS && m.tower_wait_stale({}, o)].filter(Boolean).join(" · ");
}
/** The alerts of a tower's fresh waits for the boss that the boss has not answered yet (an answered one is the tower's to resolve: no view raises it again, and a wait that changed is a new one), each by its own key (a wait's id is never reused), as of `at`. A parked wait (auto mode is on, docs/specs/2026-11-09-auto-mode.md D8) is none: it raises no system notification, sound or Zen cue and stays out of the dock queue and the tab's count; it is on the card and in the rows, and an ordinary wait again when auto mode ends. */
export function waitAlerts(ws: string, tower: Base["tower"], at: number): Alert[] {
	return (tower?.service?.memory?.bossWaits ?? []).filter((w) => age(w.at, at) < FRESH_MS && !w.answered && !w.state && !w.parked && !w.listed).map((w): Alert => ({ key: `wait\u001f${ws}\u001f${w.id}`, unit: tower!.key, ws, name: tower!.name, role: "tower", mark: "waiting", note: waitSubject(w), at, since: Date.parse(w.at), closed: !tower!.control, wait: { id: w.id, text: waitSubject(w), entry: w } }));
}
