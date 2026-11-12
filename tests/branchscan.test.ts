import assert from "node:assert/strict";
import { test } from "node:test";
import { newestOf } from "../src/branchscan.ts";
import { BOARD_ENTRY, withdrawnKey, withdrawnScan } from "../src/boardseed.ts";
import { snapshotOfBranch, snapshotScan } from "../src/todo.ts";

// The incremental reading of a session branch (src/branchscan.ts): the work board's refresh runs at every tool call, so what it reads from the branch must cost what was appended since the last read,
// and give what the full walk gives whatever happened to the branch in between.

const cleared = (key: unknown) => ({ type: "custom", customType: BOARD_ENTRY, data: { cleared: key } });
const message = (n: number) => ({ type: "message", message: { role: "assistant", n } });
const state = (tasks: unknown) => ({ type: "custom", customType: "rpiv-todo-state", data: { tasks, nextId: 9 } });
const result = (tasks: unknown) => ({ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks, nextId: 9 } } });
const task = (id: number) => ({ id, subject: `t${id}`, status: "pending" });

test("newestOf reads only what was appended since its last read", () => {
	let picks = 0;
	const scan = newestOf((e) => (picks++, (e as { hit?: string }).hit));
	const branch: { hit?: string }[] = Array.from({ length: 1000 }, () => ({}));
	assert.equal(scan(branch), undefined);
	assert.equal(picks, 1000, "the first read walks the branch");
	picks = 0;
	assert.equal(scan([...branch]), undefined, "pi hands a new array at each getBranch: the entries are the same objects");
	assert.equal(picks, 0, "nothing was appended");
	branch.push({}, { hit: "a" }, {});
	assert.equal(scan([...branch]), "a");
	assert.equal(picks, 2, "from the new leaf to the hit, and never past the old leaf");
	picks = 0;
	branch.push({}, {});
	assert.equal(scan([...branch]), "a", "what an earlier read found stands while nothing newer matches");
	assert.equal(picks, 2);
	branch.push({ hit: "b" });
	assert.equal(scan([...branch]), "b");
});

test("newestOf walks again when the branch is not the one it read: another branch of the tree, a shorter one, an empty one", () => {
	const scan = newestOf((e) => (e as { hit?: string }).hit);
	const root = { hit: "root" }, a = [root, {}, { hit: "a" }, {}], b = [root, {}, {}, {}, {}];
	assert.equal(scan(a), "a");
	assert.equal(scan(b), "root", "a sibling branch that is longer: the entry at the old leaf's place is another one");
	assert.equal(scan(a), "a");
	assert.equal(scan(a.slice(0, 2)), "root", "the leaf moved back to an ancestor");
	assert.equal(scan([]), undefined);
	assert.equal(scan([{}, {}]), undefined, "nothing of an earlier branch is remembered");
	assert.equal(scan(a), "a");
});

test("withdrawnScan gives what withdrawnKey gives as a branch grows, with a later cleared entry and a switch of branch", () => {
	const scan = withdrawnScan();
	const branch: unknown[] = [];
	const same = (why: string) => assert.equal(scan([...branch]), withdrawnKey(branch), why);
	same("empty");
	for (let i = 0; i < 50; i++) branch.push(message(i));
	same("no cleared entry");
	branch.push(cleared("k1"));
	same("the first cleared entry");
	assert.equal(scan([...branch]), "k1");
	for (let i = 0; i < 20; i++) branch.push(message(i));
	same("messages after it");
	branch.push(cleared(3));
	same("a cleared entry that is no key is not one");
	branch.push(cleared("k2"), message(0));
	same("a later cleared entry");
	assert.equal(scan([...branch]), "k2");
	branch.splice(60);
	same("the leaf moved back before the second one");
	branch.splice(10);
	same("and before the first");
});

test("snapshotScan gives what snapshotOfBranch gives on every prefix of a branch, and after a switch of branch", () => {
	// Every shape the full walk tells apart: a state entry wins over any tool result, the newest valid one of each kind counts, and one that is no todo list is skipped.
	const entries = [message(0), result([task(1)]), message(1), result("bad"), result([task(1), task(2)]), message(2), state([task(3)]), result([task(4)]), state("bad"), message(3), state([task(5)]), result([task(6)])];
	const scan = snapshotScan();
	for (let n = 0; n <= entries.length; n++) assert.deepEqual(scan(entries.slice(0, n)), snapshotOfBranch(entries.slice(0, n)), `the first ${n}`);
	for (const n of [8, 3, 0, 12, 5]) assert.deepEqual(scan(entries.slice(0, n)), snapshotOfBranch(entries.slice(0, n)), `back to ${n}`);
	const other = [entries[0], entries[1], message(9), message(9), message(9), message(9), message(9), message(9)];
	assert.deepEqual(scan(entries), snapshotOfBranch(entries));
	assert.deepEqual(scan(other), snapshotOfBranch(other), "a sibling branch");
	assert.equal(scan(entries), snapshotOfBranch(entries), "the same snapshot object, as the full walk hands it");
});
