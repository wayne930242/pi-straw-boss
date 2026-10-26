import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { RelayClient } from "../src/link/relay.ts";
import type { Agent } from "./fakes.ts";
import { alice, rosterOf } from "./link/holder-world.ts";
import { relayHasKind, relaySkip, startRelay, type LiveRelay } from "./link/live-relay.ts";
import { type Computer, computer } from "./link/remote-world.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { TEAM } from "./link/scenario.ts";

// The work board between two clients and a real straw-relay that has the `board` kind in its table (docs/specs/2026-10-25-straw-link.md, Work board,
// Tests and anchor): a main on A calls board_set and B's tower sees the entry in board_read; the entry cleared on A disappears on B. Skipped where
// `go` or the relay checkout is missing; STRAW_RELAY_DIR names a checkout that has the kind (the branch feat/board-kind of straw-relay).

const skip = relaySkip || (relayHasKind("board") ? false : "skipped: the straw-relay checkout has no `board` kind (merge feat/board-kind, or set STRAW_RELAY_DIR)");
if (skip) console.log(`# link-board-live ${skip}`);
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((x) => x.text).join("");
interface Read { local: unknown[]; remote?: { entries: { now: string }[]; device: { label: string } }[] }
async function until(check: () => Promise<unknown>, ms: number, what: string) {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await check()) return;
	throw new Error(`timed out waiting for ${what}`);
}

describe("the work board against the real relay", { skip }, () => {
	const root = mkdtempSync(join(tmpdir(), "psb-board-live-測試-"));
	let relay!: LiveRelay;
	const computers: Computer[] = [];
	before(async () => {
		relay = await startRelay();
		const entries = rosterOf(), a = new RelayClient({ url: relay.url, device: alice });
		await a.createTeam({ team: TEAM, token: relay.token, entry: entries[0]! });
		await a.appendRoster(TEAM, entries[1]!);
	});
	after(async () => {
		for (const c of computers) await c.world.stopAll();
		await relay?.stop();
		rmSync(root, { recursive: true, force: true });
	});

	it("a main's entry on A reaches B's tower within 20 seconds, and disappears when the main ends", async () => {
		const real = (url: string, device: typeof alice) => new RelayClient({ url, device });
		const [a, b] = (["a", "b"] as const).map((who) => computer(root, new FakeRelay(), who, { url: relay.url, client: real as never }));
		computers.push(a!, b!);
		const main: Agent = a!.world.agent({ id: "main-a", name: "api main", pane: "wA:p1", tab: "wA:t1", deps: a!.deps });
		a!.world.herdr.pane("wA:p1").cwd = a!.project;
		await Promise.all([a!.tower.start(), b!.tower.start()]);
		await main.start();
		await main.promote();
		const started = Date.now();
		const answer = text(await main.tool("board_set", { now: "MP-1 export: CSV writer", items: [{ t: "schema", done: true }, { t: "writer", done: false }] }));
		assert.match(answer, /team project-a \(1 device\)/);
		const read = async () => JSON.parse(text(await b!.tower.tool("board_read"))) as Read;
		await until(async () => (await read()).remote?.[0]?.entries.some((e) => e.now === "MP-1 export: CSV writer"), 20_000, "the entry at B");
		console.log(`# link-board-live: the entry reached B after ${Date.now() - started} ms`);
		assert.equal((await read()).remote![0]!.device.label, "alice-mac");
		await main.stop("quit");
		await until(async () => (await read()).remote?.[0]?.entries.length === 0, 20_000, "the entry gone at B");
	});
});
