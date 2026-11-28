import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { run } from "../src/server/cli.ts";
import { recordPath, type RoleRecord } from "../src/roles.ts";
import { TowerWorld } from "./tower-world.ts";
import { until } from "./server-world.ts";
import { fakeClock } from "./fake-clock.ts";
import { pruneState } from "../src/server/stateprune.ts";
import { fileOf } from "../src/server/record.ts";
import { ledgerPath } from "../src/revive.ts";
import { writeBoard } from "../src/train/board.ts";

const DAY = 86_400_000, NOW = new Date(2026, 10, 23, 12).getTime();
const write = (path: string, value: unknown) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value) + "\n");
	return path;
};

function role(w: TowerWorld, i: number, over: Partial<RoleRecord> = {}, age = 40 * DAY) {
	const id = `0000000${i}-1111-2222-3333-444444444444`, file = join(w.env.PI_CODING_AGENT_DIR!, "sessions", `old_${id}.jsonl`);
	write(file, { type: "session", id });
	utimesSync(file, (NOW - age) / 1000, (NOW - age) / 1000);
	const path = write(recordPath(w.stateDir, file), { role: "main", at: NOW - 40 * DAY, pane: `gone:${i}`, workspace: "gone", tab: "t1", file, ...over } satisfies RoleRecord);
	utimesSync(path, (NOW - 40 * DAY) / 1000, (NOW - 40 * DAY) / 1000);
	return { path, file, id };
}

test("startup retains a revivable dead main, a recent role and a handed-off predecessor of a live successor; keeps a stale role inside the restore window", async () => {
	const w = new TowerWorld();
	try {
		const stale = role(w, 1), revivable = role(w, 2, {}, 2 * 3600_000), young = role(w, 3, { at: NOW - 13 * DAY });
		const successor = role(w, 4), previous = role(w, 5, { handedOver: { at: NOW - 20 * DAY, to: successor.id } });
		const tower = role(w, 6, { role: "tower", pane: "wA:p3", workspace: "wA", tab: "wA:t1" });
		w.herdr.addPane("wA:p3", "wA:t1");
		const trainId = { project: "acme", code: "2026-10-01-a" }, train = role(w, 7, { role: "train", train: trainId });
		writeBoard(w.stateDir, { v: 1, ...trainId, app: "web", updated: new Date(NOW - 40 * DAY).toISOString(), round: 1, writer: { session: train.id, pid: 4001, started: new Date(NOW - 40 * DAY).toISOString() }, cars: [], steps: [] });
		w.sessions.push({ id: successor.id });
		// One clock for the server and its towers (TowerWorld.towerClock): the towers read Herdr's clock, which was the machine's, so the restore window was 150 ms (recoverMs) of real time from their activation, and a
		// prune that came later under load (every Herdr call 100 ms late) sighted the stale role. The clock stands still here: the prune runs inside the window.
		const clock = (w.towerClock = fakeClock(NOW));
		await w.start({ gui: false, now: clock.now });
		await until(() => /state-prune/.test(readFileSync(fileOf(w.slot, "log"), "utf8")), "startup prune ran");
		// Startup falls in the tower restore window: no role goes and no sighting starts.
		assert.ok(!existsSync(join(dirname(stale.path), ".missing-since.json")));
		for (const item of [stale, revivable, young, successor, previous, tower, train]) assert.ok(existsSync(item.path), item.path);
	} finally { await w.close(); }
});

test("dry-run flag is required and never starts or edits a server", async () => {
	const w = new TowerWorld(), output: string[] = [];
	try {
		const row = role(w, 1);
		const deps = { env: w.env, stateDir: w.stateDir, pruneSessions: async () => [], out: (text: string) => output.push(text), err: () => {}, herdrCli: w.herdr.runFor("none"), server: () => assert.fail("no server start") };
		assert.equal(await run(["prune"], deps), 2);
		assert.equal(await run(["prune", "--dry-run"], deps), 0);
		assert.equal(JSON.parse(output.join("")).dryRun, true);
		assert.ok(existsSync(row.path));
	} finally { await w.close(); }
});

test("a missing tower has 14 days from the first successful absence; reappearance resets the clock and failures do not count", async () => {
	const w = new TowerWorld(), dir = join(w.stateDir, "tower", "wGone"), marker = join(dir, ".missing-since.json");
	try {
		write(join(dir, "memory.json"), {});
		let now = NOW, found = false, herdrDown = true, brokerDown = false;
		const row = role(w, 1);
		const scan = (dryRun = false) => pruneState({ slot: w.slot, env: w.env, now: () => now,
			panes: async () => [], workspaces: async () => { if (herdrDown) throw new Error("offline"); return found ? [{ workspace_id: "wGone", label: "back" }] : []; },
			sessions: async () => { if (brokerDown) throw new Error("offline"); return []; },
		}, dryRun);
		assert.equal((await scan()).skipped.tower, "Herdr could not be read");
		assert.ok(existsSync(row.path));
		assert.ok(!existsSync(marker));
		herdrDown = false;
		assert.equal((await scan(true)).tower.newlyMissing, 1);
		assert.ok(!existsSync(marker));
		assert.equal((await scan()).tower.newlyMissing, 1);
		now += 14 * DAY - 1;
		assert.equal((await scan()).tower.remove, 0);
		found = true;
		assert.equal((await scan()).tower.reset, 1);
		found = false;
		assert.equal((await scan()).tower.newlyMissing, 1);
		now += 14 * DAY;
		brokerDown = true;
		assert.equal((await scan()).skipped.trainboard, "broker could not be read");
		assert.ok(existsSync(dir));
		brokerDown = false;
		assert.equal((await scan(true)).tower.remove, 1);
		assert.ok(existsSync(dir));
		assert.equal((await scan()).tower.remove, 1);
		assert.ok(!existsSync(dir));
	} finally { await w.close(); }
});

test("an old revive ledger without a role or lock goes, but a retained role, lock, and young ledger protect theirs", async () => {
	const w = new TowerWorld();
	try {
		const keepRole = role(w, 1, {}, 2 * 3600_000);
		const paths = [keepRole.file, "orphan", "locked", "young"].map((file) => write(ledgerPath(w.stateDir, file), { file }));
		for (const path of paths.slice(0, 3)) utimesSync(path, (NOW - 8 * DAY) / 1000, (NOW - 8 * DAY) / 1000);
		write(`${paths[2]}.lock`, {});
		const got = await pruneState({ slot: w.slot, env: w.env, now: () => NOW, panes: async () => [], workspaces: async () => [], sessions: async () => [] });
		assert.deepEqual(got.revive, { scanned: 4, remove: 1 });
		assert.deepEqual(paths.map(existsSync), [true, false, true, true]);
	} finally { await w.close(); }
});

const HOUR = 3_600_000;
const scanRoles = (w: TowerWorld, now: number, recovering = false) => pruneState({ slot: w.slot, env: w.env, now: () => now, recovering: () => recovering, panes: async () => [], workspaces: async () => [], sessions: async () => [] });

test("a role whose pane is absent during the restore window is kept and gets no sighting", async () => {
	const w = new TowerWorld();
	try {
		const row = role(w, 1);
		assert.equal((await scanRoles(w, NOW, true)).roles.remove, 0);
		assert.equal((await scanRoles(w, NOW + 2 * HOUR, true)).roles.remove, 0);
		assert.ok(existsSync(row.path));
		// The restore window gave no sighting: the first one after it does not remove.
		assert.equal((await scanRoles(w, NOW + 3 * HOUR)).roles.remove, 0);
		assert.ok(existsSync(row.path));
	} finally { await w.close(); }
});

test("a single missed sighting keeps the role, and a sighting under an hour later still keeps it", async () => {
	const w = new TowerWorld();
	try {
		const row = role(w, 1);
		assert.deepEqual((await scanRoles(w, NOW)).roles, { scanned: 1, remove: 0, sighted: 1 });
		assert.equal((await scanRoles(w, NOW + HOUR - 1)).roles.remove, 0);
		assert.ok(existsSync(row.path));
	} finally { await w.close(); }
});

test("two missed sightings an hour apart delete the role; a pane that reappears clears the first sighting", async () => {
	const w = new TowerWorld();
	try {
		const row = role(w, 1), back = role(w, 2), sightings = join(dirname(row.path), ".missing-since.json");
		await scanRoles(w, NOW);
		await pruneState({ slot: w.slot, env: w.env, now: () => NOW + 30 * 60_000, panes: async () => [{ pane_id: "gone:2" } as never], workspaces: async () => [], sessions: async () => [] });
		assert.deepEqual(Object.keys(JSON.parse(readFileSync(sightings, "utf8"))), [basename(row.path)]);
		const got = await scanRoles(w, NOW + HOUR);
		assert.equal(got.roles.remove, 1);
		assert.ok(!existsSync(row.path));
		assert.ok(existsSync(back.path), "the reappeared pane restarted its clock");
		assert.deepEqual(Object.keys(JSON.parse(readFileSync(sightings, "utf8"))), [basename(back.path)]);
	} finally { await w.close(); }
});
