import type { Mark } from "../src/dashboard.ts";
import type { Net } from "../src/net.ts";
import { m } from "./paraglide/messages.js";

export interface Entry { text: string; mark: Mark }

const WORDS: Record<Mark, (i: { name: string }) => string> = { commanding: m.log_commanding, working: m.log_working, waiting: m.log_waiting, idle: m.log_idle, done: m.log_done, error: m.log_error, unknown: m.log_unknown };

/** Everything in a net that has a state, by id: towers, agents, subagents, and outposts. */
function named(net: Net): Map<string, { name: string; mark: Mark }> {
	const all = new Map<string, { name: string; mark: Mark }>();
	for (const base of net.bases) {
		if (base.tower) all.set(`tower:${base.id}`, { name: m.tower_name({ label: base.label }), mark: base.tower.mark });
		for (const u of [...(base.tower?.subs ?? []), ...base.tabs.flatMap((t) => t.units.flatMap((unit) => [unit, ...unit.subs]))]) all.set(u.id, { name: u.name, mark: u.mark });
		for (const o of base.outposts) all.set(o.id, { name: o.label, mark: o.mark });
	}
	return all;
}

/** What changed between two snapshots, as log lines. The first snapshot (no previous one) logs nothing. */
export function changes(prev: Net | undefined, next: Net): Entry[] {
	if (!prev) return [];
	const [before, after] = [named(prev), named(next)];
	const entries: Entry[] = [];
	for (const [id, now] of after) {
		const was = before.get(id);
		if (!was) entries.push({ text: m.log_joined({ name: now.name }), mark: now.mark });
		else if (was.mark !== now.mark) entries.push({ text: WORDS[now.mark]({ name: now.name }), mark: now.mark });
	}
	for (const [id, was] of before) if (!after.has(id)) entries.push({ text: m.log_left({ name: was.name }), mark: "idle" });
	return entries;
}
