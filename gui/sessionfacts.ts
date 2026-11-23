import type { Mark } from "../src/netdata.ts";
import { type Activity, type Unit as Facts, wakeOf } from "./composer.ts";
import { liveNote } from "./render.ts";
import { closed } from "./scene.ts";

// The facts a session's composer reads (its activity ring and words among them), decided once for the session view and Zen's companion. `u` is the net's unit (or the history header's who); none for an ally or event run, which `role` names.
type U = { control?: boolean; ended?: boolean; note?: string; pending?: { answer?: unknown }; service?: Parameters<typeof wakeOf>[0] & { headless?: boolean } };
export const composerUnit = (u: U | undefined, { name, mk, state, online, away, role, head }: { name: string; mk: Mark; state?: string; online: boolean; away?: boolean; role?: string; head?: boolean }): Facts => ({ name, control: Boolean(u?.control), live: !closed(u, state), mark: mk, online, away, answerable: Boolean(u?.pending?.answer), ...wakeOf(u?.service ?? (head ? { state: "absent", allyRuns: [] } : undefined)), head: Boolean(head), ...(u?.service?.headless ? { headless: true } : {}), activity: activityOf(u, state, mk), ally: !u && (role === "ally" || role === "run"), run: !u && role === "run" });
/** What the unit is doing, for the composer: the words (render.ts `liveNote`: none for a session that is not live or is at rest), the mark of the ring round the box, and which working state it is (what the monitor, the tool, or the thought is). */
export function activityOf(u: U | undefined, state: string | undefined, mk: Mark): Activity | undefined {
	const text = liveNote(u, state, mk);
	if (!text) return undefined;
	const note = u?.note ?? "";
	return { text, mark: mk, kind: note.startsWith("tool:") ? "tool" : note === "watching a monitor" ? "monitoring" : "thinking" };
}
