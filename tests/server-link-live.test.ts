import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { TOWER_LABEL } from "../src/herdr.ts";
import { RelayClient } from "../src/link/relay.ts";
import { LinkStore } from "../src/link/store.ts";
import { callControl } from "../src/server/socket.ts";
import { World } from "./fakes.ts";
import { alice, bob, rosterOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { relaySkip, startRelay, type LiveRelay } from "./link/live-relay.ts";
import { TEAM } from "./link/scenario.ts";
import { ServerWorld, until } from "./server-world.ts";

// Two sb servers (two computers) against the real straw-relay (docs/specs/2026-10-26-sb-backend.md, B3): the link holder in each server streams from the relay, a `send` that a tower
// puts to its server's control socket reaches the other computer's inbox, and that server offers it to the tower on the intercom channel. The servers run in this process
// with a stub intercom client; the relay is the real one (tests/link/live-relay.ts). Skipped where `go` or the relay checkout is missing.

if (relaySkip) console.log(`# server-link-live ${relaySkip}`);

describe("two sb servers against the real relay", { skip: relaySkip }, () => {
	let relay!: LiveRelay;
	const worlds: ServerWorld[] = [], fakes: World[] = [];

	/** One computer: a state directory with the device's keys and the team, a project with a tower pane in it, and a server whose Herdr is that fake. */
	const computer = async (who: "a" | "b") => {
		const sw = new ServerWorld(), herdr = new World();
		worlds.push(sw);
		fakes.push(herdr);
		const keys = who === "a" ? alice : bob, entries = rosterOf();
		const project = join(sw.root, "home", `project-${who}`);
		mkdirSync(project, { recursive: true });
		const real = realpathSync(project), store = new LinkStore(join(sw.stateDir, "link"));
		writeDevice(store, keys, `${who === "a" ? "alice" : "bob"}-mac`);
		writeTeam(store, entries, keys, { relay: relay.url });
		writeFileSync(join(sw.stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: false }, link: { relay: relay.url, teams: { [TEAM_HEX]: { project: real, share: "status" } } } }));
		herdr.herdr.addTab("wA:t7", TOWER_LABEL);
		herdr.herdr.addPane("wA:p7", "wA:t7");
		Object.assign(herdr.herdr.pane("wA:p7"), { cwd: real, tokens: { sb_role: "tower" } });
		const server = await sw.start({ link: { tickMs: 50, drainMs: 100, presenceMs: 60_000, home: join(sw.root, "home") }, herdr: { run: herdr.herdr.runFor("") } });
		server.client.sessions = [{ id: `tower-${who}`, name: `tower-${who}`, herdrLocation: { status: "current", paneId: "wA:p7", tab: { id: "wA:t7", label: TOWER_LABEL }, workspace: { id: "wA", label: "Alpha" } } }] as never;
		await server.handle.ready;
		const record = () => sw.record()!;
		const link = async (from: string, body: Record<string, unknown>) => (await callControl(record().socket, record().secret, { cmd: "link", from, body } as { cmd: string })).reply!.answer as { ok: boolean; error?: string; [key: string]: unknown };
		return { sw, server, store, link };
	};

	before(async () => {
		relay = await startRelay();
		const entries = rosterOf(), a = new RelayClient({ url: relay.url, device: alice });
		await a.createTeam({ team: TEAM, token: relay.token, entry: entries[0]! });
		await a.appendRoster(TEAM, entries[1]!);
	});
	after(async () => {
		await Promise.allSettled(worlds.map((w) => w.close()));
		await Promise.allSettled(fakes.map((w) => w.stopAll()));
		await relay?.stop();
	});

	it("a tower's send on one server's socket reaches the other server's inbox, is offered to its tower, and leaves the inbox once the tower says `taken`", async () => {
		const [a, b] = [await computer("a"), await computer("b")];
		for (const c of [a, b]) {
			await until(() => c.store.readHolder()?.session === c.sw.record()!.intercomId, "the server as holder");
			await until(async () => (await c.link("x", { op: "list" })).ok, "an active holder");
		}
		const sent = await a.link("tower-a", { op: "send", device: "bob-mac", text: "hello from A's server", reply: false });
		assert.equal(sent.ok, true, JSON.stringify(sent));
		await until(() => b.store.inboxIds().some((id) => b.store.readInbox(id)?.text === "hello from A's server"), "the message in B's inbox");
		const offers = () => b.server.client.frames.filter((f) => f.type === "extension_publish" && (f.payload as { type?: string })?.type === "offer");
		await until(() => offers().length > 0, "the offer to B's tower on the channel");
		const offer = offers()[0]!.payload as { to: string; id: string };
		assert.equal(offer.to, "tower-b");
		assert.deepEqual((await b.link("tower-b", { op: "taken", id: offer.id })).ok, true);
		await until(() => b.store.inboxIds().length === 0, "the inbox emptied by `taken`");
		assert.equal(a.store.inboxIds().length, 0);
		const status = (await callControl(a.sw.record()!.socket, a.sw.record()!.secret, { cmd: "status" })).reply as unknown as { link: { holding: boolean; active: boolean } };
		assert.deepEqual([status.link.holding, status.link.active], [true, true]);
	});
});
