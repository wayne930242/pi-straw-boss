import assert from "node:assert/strict";
import { test } from "node:test";
import type { Base, Net, Unit } from "../src/net.ts";
import { locate, towerBase } from "../gui/scene.ts";

// A tower's comms offer "+ Main" for the tower's own base, and no other unit's comms do.

const unit = (key: string, role: string): Unit => ({ key, name: key, role, mark: "idle", control: true, subs: [] }) as unknown as Unit;
const base = (id: string, tower: boolean, units: Unit[] = []): Base => ({ id, label: id, mark: "idle", head: false, tower: tower ? { name: `tower ${id}`, mark: "idle", key: `t-${id}`, control: true, subs: [unit(`s-${id}`, "subagent")] } : null, tabs: [{ id: `${id}:t1`, label: "squad", units }], outposts: [], outside: [] }) as unknown as Base;
const net: Net = { bases: [base("a", true, [unit("a-main", "main")]), base("b", false, [unit("b-member", "member")])] };

test("a tower's comms name its base for the opening button", () => {
	assert.equal(towerBase(locate(net, "t-a"))?.id, "a");
});

test("a main, a member, a subagent, an unknown key, or a base without a tower gives no opening", () => {
	for (const key of ["a-main", "b-member", "s-a", "nobody"]) assert.equal(towerBase(locate(net, key)), undefined, key);
	assert.equal(towerBase(undefined), undefined);
});
