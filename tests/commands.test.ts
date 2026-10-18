import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkCommands, listCommands, MAX_COMMANDS } from "../src/commands.ts";
import { slashPrefix, step } from "../gui/slash.ts";

const pi = (list: unknown[]) => ({ getCommands: () => list }) as unknown as Pick<ExtensionAPI, "getCommands">;

test("a session lists its commands that start with the prefix, then those that contain it, each by name, case-insensitive and capped", () => {
	const all = [{ name: "skill:review", source: "skill" }, { name: "Review", source: "prompt", description: "Review the diff" }, { name: "boss", source: "extension" }, { name: "prereview", source: "prompt" }];
	assert.deepEqual(listCommands(pi(all), "rev").map((c) => c.name), ["Review", "prereview", "skill:review"]);
	assert.deepEqual(listCommands(pi(all), "").map((c) => c.name), ["boss", "prereview", "Review", "skill:review"]);
	assert.deepEqual(listCommands(pi(all), "zzz"), []);
	assert.equal(listCommands(pi(Array.from({ length: 50 }, (_, i) => ({ name: `c${i}`, source: "skill" }))), "c").length, MAX_COMMANDS);
	assert.equal(listCommands(pi([{ name: "a", source: "skill", description: "d".repeat(500) }]), "")[0]!.description!.length, 160, "a long description is cut");
	assert.deepEqual(listCommands({ getCommands: () => { throw new Error("old pi"); } } as never, ""), [], "a pi without the API lists nothing");
});

test("the server takes a bridge's list only when every entry is in shape, and keeps only the fields it knows", () => {
	assert.deepEqual(checkCommands([{ name: "a", source: "skill", extra: true }]), [{ name: "a", source: "skill" }]);
	assert.deepEqual(checkCommands([]), []);
	for (const bad of [null, "a", [{ name: "", source: "skill" }], [{ name: "a b", source: "skill" }], [{ name: "a", source: "builtin" }], [{ name: "a", source: "skill", description: 3 }], [{ name: "a", source: "skill", description: "d".repeat(161) }], Array(31).fill({ name: "a", source: "skill" })]) assert.equal(checkCommands(bad), undefined, JSON.stringify(bad).slice(0, 60));
});

test("the composer's menu asks only while the box holds one `/word` being typed, and its arrows wrap", () => {
	assert.equal(slashPrefix("/"), "");
	assert.equal(slashPrefix("/rev"), "rev");
	for (const text of ["", "rev", "/rev ", "/rev x", " /rev", "/a\nb", `/${"x".repeat(65)}`]) assert.equal(slashPrefix(text), undefined, JSON.stringify(text));
	assert.deepEqual([step(0, 3, 1), step(2, 3, 1), step(0, 3, -1)], [1, 0, 2]);
});
