import assert from "node:assert/strict";
import { test } from "node:test";
import { speaker } from "../gui/chat.ts";
import { locales } from "../gui/paraglide/runtime.js";
import { m } from "../gui/paraglide/messages.js";
import { aimSession, leave } from "../gui/quit.ts";
import type { Route } from "../gui/router.ts";
import type { Base, Net, Unit } from "../src/net.ts";

// A unit's own session view: its chat names who speaks by role (the page header names the session), and its header carries the map's Quit for that unit.

const unit = (key: string, role: Unit["role"] | "tower", extra: Partial<Unit> = {}): Unit => ({ id: key, key, name: `${key}-name`, role: role as Unit["role"], mark: "idle", control: true, subs: [], ...extra });
const base = (units: Unit[], tower?: Unit): Base => ({ id: "w1", label: "Harbor", mark: "idle", head: true, tower: tower ?? null, outposts: [], outside: [], tabs: [{ id: "w1:t1", label: "squad", units }] }) as unknown as Base;
/** The few things aim() touches on a button. */
const button = () => {
	const attrs: Record<string, string> = {};
	return Object.assign({ dataset: { close: "unit" } as Record<string, string>, hidden: true, textContent: "", setAttribute: (k: string, v: string) => void (attrs[k] = v), attrs }) as unknown as HTMLElement & { attrs: Record<string, string> };
};

test("an assistant message is from its unit's role, not the session's name, in every locale", () => {
	const roles = { tower: m.role_tower, main: m.role_main, member: m.role_member, subagent: m.role_subagent };
	for (const [role, label] of Object.entries(roles)) {
		assert.equal(speaker({ role }), label(), role);
		for (const locale of locales) assert.ok(label({}, { locale }).length > 0, `${role} in ${locale}`);
	}
	assert.equal(speaker({ role: "robot" }), "robot", "a role the page does not know shows as it is");
});

test("the session view's Quit is the map's: a controllable main or member gets it with the map's data and wording", () => {
	for (const role of ["main", "member"] as const) {
		const u = unit("a1", role), b = button();
		aimSession(b, { u, base: base([u]) });
		assert.equal(b.hidden, false, role);
		assert.deepEqual({ ...b.dataset }, { close: "unit", key: "a1", name: "a1-name", role }, role);
		assert.equal(b.textContent, m.quit());
		assert.equal(b.attrs["aria-label"], m.close_unit({ name: "a1-name" }));
	}
});

test("the tower's own session quits the tower alone, as the map's Quit tower does", () => {
	const t = unit("t1", "tower"), b = button();
	aimSession(b, { u: t, base: base([], t) });
	assert.deepEqual([b.hidden, b.dataset.close, b.dataset.key, b.dataset.role, b.textContent], [false, "unit", "t1", "tower", m.quit_tower()]);
	const free = button();
	aimSession(free, { u: { ...t, control: false }, base: base([], { ...t, control: false }) });
	assert.equal(free.hidden, true, "a tower the page cannot control has no Quit");
});

test("no Quit where the map shows none: a unit the page cannot control, a subagent, a finished subagent (its Dismiss is the map's), and a unit that left the net", () => {
	const cases: [string, Unit][] = [["no control", unit("m1", "member", { control: false })], ["subagent", unit("s1", "subagent")], ["finished subagent", unit("s2", "subagent", { ended: true })]];
	for (const [what, u] of cases) {
		const b = button();
		aimSession(b, { u, base: base([u]) });
		assert.equal(b.hidden, true, what);
	}
	const gone = button();
	aimSession(gone, undefined);
	assert.equal(gone.hidden, true, "left the net");
	const back = button(), u = unit("a1", "main");
	aimSession(back, { u: unit("s2", "subagent", { ended: true }), base: base([u]) });
	aimSession(back, { u, base: base([u]) });
	assert.deepEqual([back.hidden, back.dataset.close], [false, "unit"], "a button that was aimed at a Dismiss comes back as a Quit");
});

test("a quit that went takes its own session back to its base; another session or the map stays", () => {
	const u = unit("a1", "main"), net = { bases: [base([u])] } as unknown as Net;
	const run = (route: Route) => {
		const went: Route[] = [];
		leave({ close: "unit", key: "a1", name: "a1-name", role: "main" } as unknown as DOMStringMap, { route: () => route, net: () => net, go: (r) => void went.push(r) });
		return went;
	};
	assert.deepEqual(run({ view: "session", ws: "w1", key: "a1" }), [{ view: "workspace", ws: "w1" }]);
	assert.deepEqual(run({ view: "session", ws: "w1", key: "other" }), []);
	assert.deepEqual(run({ view: "map" }), []);
});
