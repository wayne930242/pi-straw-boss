import type { Shelf } from "./documents.ts";
import type { Mark } from "./netdata.ts";
import type { Base, Net, Unit } from "./net.ts";
import type { OperateScope } from "./operateroutes.ts";

// What the box shows an operate session (docs/specs/2026-11-07-link-operate.md §6.2): its net, cut down to the units in the session's scope before anything leaves the box. A unit is shown by its own key (`scope.has`); a unit
// out of scope takes everything under it with it. A base whose tower is not in scope keeps its in-scope tabs and units with `tower: null`. Never shown: `link` (the box's own allies, alerts and confirms), `stashed`, `trust`, `head`
// (box-wide), the events of units out of scope, every shelf document's capability (decision 12: the cards keep their names, `cap` never crosses, and nothing here serves a document), and the Asks, their list and each unit's or tower's count (local only: docs/specs/2026-11-28-boss-asks.md, asks-r3-F002). An outpost (a sub workspace) belongs to nobody: the box part only.

/** A unit or tower with its shelf's names but no capabilities (decision 12: names only, never served): a document's `cap` is what opens it, and nothing else of a card grants anything. `docsCut` stays; its count of Asks goes. */
const bare = <T extends Shelf & { asks?: number }>({ docs, asks: _asks, ...rest }: T): T => (docs ? { ...rest, docs: docs.map(({ cap: _cap, ...card }) => card) } : rest) as unknown as T;
const keep = (scope: OperateScope) => function unit(u: Unit): Unit[] {
	return scope.has(u.key) ? [{ ...bare(u), subs: u.subs.flatMap(unit) }] : [];
};
const marksOf = (b: Pick<Base, "tower" | "tabs" | "outposts" | "outside">): Mark[] => [...(b.tower ? [b.tower.mark, ...b.tower.subs.map((c) => c.mark)] : []), ...b.tabs.flatMap((t) => t.units.flatMap((u) => [u.mark, ...u.subs.map((c) => c.mark)])), ...b.outside.flatMap((u) => [u.mark, ...u.subs.map((c) => c.mark)]), ...b.outposts.map((o) => o.mark)];

export function sliceNet(net: Net, scope: OperateScope): Net {
	const units = keep(scope);
	const bases = net.bases.flatMap((b): Base[] => {
		// Out of the box part the tower is not shown, but the live ally runs this scope's own keys name are the team's (§4 row 1): they stay, on a stub that holds nothing else of the tower.
		const own = b.tower?.service?.allyRuns.filter((r) => r.key !== undefined && scope.has(r.key)) ?? [];
		const tower: Base["tower"] = b.tower && scope.has(b.tower.key) ? { ...bare(b.tower), subs: b.tower.subs.flatMap(units) } : b.tower && own.length ? { name: b.tower.name, mark: "idle", key: b.tower.key, control: false, subs: [], service: { state: "standing", queued: 0, allyRuns: own, notices: [], parked: [] } } : null;
		const tabs = b.tabs.flatMap((t) => ((u) => (u.length ? [{ ...t, units: u }] : []))(t.units.flatMap(units)));
		const outside = b.outside.flatMap(units), outposts = scope.box ? b.outposts : [];
		if (!tower && !tabs.length && !outside.length && !outposts.length) return [];
		// The base's mark is the one that needs attention most among what is left, always recomputed: the net's own comes from the whole workspace's status, which holds other teams' units, so it never shows through.
		const left = marksOf({ tower, tabs, outposts, outside }), mark: Mark = left.includes("waiting") ? "waiting" : left.includes("working") ? "working" : "idle";
		return [{ ...b, mark, tower, tabs, outposts, outside }];
	});
	const events = net.events?.filter((e) => (e.key === undefined ? scope.box : scope.has(e.key)));
	return { bases, ...(events?.length ? { events } : {}) };
}
