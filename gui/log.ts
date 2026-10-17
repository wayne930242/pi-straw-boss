import type { Mark } from "../src/dashboard.ts";
import type { Net } from "../src/net.ts";

export interface Entry { text: string; mark: Mark }

const WORDS: Record<Mark, string> = { working: "started working", waiting: "is waiting on a question", idle: "went idle", done: "finished", error: "hit an error", unknown: "lost its status" };

/** Everything in a net that has a state, by id: towers, agents, subagents, and outposts. */
function named(net: Net): Map<string, { name: string; mark: Mark }> {
	const all = new Map<string, { name: string; mark: Mark }>();
	for (const base of net.bases) {
		if (base.tower) all.set(`tower:${base.id}`, { name: `${base.label} tower`, mark: base.tower.mark });
		for (const unit of base.tabs.flatMap((t) => t.units)) for (const u of [unit, ...unit.subs]) all.set(u.id, { name: u.name, mark: u.mark });
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
		if (!was) entries.push({ text: `${now.name} joined`, mark: now.mark });
		else if (was.mark !== now.mark) entries.push({ text: `${now.name} ${WORDS[now.mark]}`, mark: now.mark });
	}
	for (const [id, was] of before) if (!after.has(id)) entries.push({ text: `${was.name} left`, mark: "idle" });
	return entries;
}
