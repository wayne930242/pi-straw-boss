import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createAsks } from "../src/server/asks.ts";
import { startLinkWaits } from "../src/server/linkwaitsops.ts";
import { slotOf } from "../src/server/record.ts";
import { WORKER_ASK_KEEP_MS } from "../src/server/workersend.ts";
import { parseWorker } from "../src/workerslip.ts";

// A controller main's call_tower worker (worker-send, docs/specs/2026-11-26-ally-workers.md, Controller side): the code writes the slip and a 7-day ask for the main, sends it as the workspace's tower identity, and refuses a box
// whose caps list no tower.worker, a member, a worker, and a bad slip; nothing is sent then.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const BOX = "n2knna6dkfud5sura2vst4gsee", ENVELOPE = "e".repeat(32);

function rig(caps: string[]) {
	const root = mkdtempSync(join(tmpdir(), "psb-worker-send-"));
	dirs.push(root);
	const slot = slotOf(join(root, "state"), { HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent") });
	const requests: { body: Record<string, unknown>; from: string }[] = [], asks = createAsks(slot);
	const link = {
		holder: { resolveTeammate: (d: string) => (d === "box" ? { ok: true, id: BOX, short: "n2knna", label: "box", team: "t1" } : { ok: false, error: `no device ${d}` }), capsFor: () => caps },
		request: async (body: Record<string, unknown>, from: string) => (requests.push({ body, from }), { ok: true, text: "Sent.", details: { team: "t1", device: BOX, id: ENVELOPE, asked: body.awaitsReply !== undefined } }),
	};
	const panes = [{ pane_id: "p1", workspace_id: "wA", tokens: { sb_role: "main" } }, { pane_id: "p2", workspace_id: "wA", tokens: { sb_role: "member" } }, { pane_id: "p3", workspace_id: "wA", tokens: { sb_role: "main", sb_duty: "worker" } }];
	const hub = startLinkWaits({ slot, env: {}, now: Date.now, log: () => {}, run: (async () => JSON.stringify({ result: { panes } })) as never, sessions: async () => [{ id: "main-1", name: "work-on", herdrLocation: { paneId: "p1" } }, { id: "member-1", name: "helper", herdrLocation: { paneId: "p2" } }, { id: "w-1", name: "worker", herdrLocation: { paneId: "p3" } }] as never, towers: () => ({ identityOf: (ws: string) => (ws === "wA" ? "sb-tower-wa" : undefined) }) as never, link: () => link as never, stops: [], asks, tickMs: false });
	return { hub, requests, asks };
}
const op = (worker: Record<string, unknown>, message = "Fix MP-1. Anchor: npm test.") => ({ op: "worker-send", device: "box", worker, message });

test("worker-send writes the slip over the brief and an ask for the main that lives 7 days; the answer reaches that main by its ask", async () => {
	const { hub, requests, asks } = rig(["tower.worker"]);
	const before = Date.now(), sent = await hub.op(op({ branch: "fix/mp-1", label: "MP-1", points: 2, model: "openai-codex/gpt-6.2-astra" }), "main-1");
	assert.equal(sent.ok, true, JSON.stringify(sent));
	const [r] = requests;
	assert.deepEqual([r!.from, r!.body.op, r!.body.device, r!.body.reply], ["sb-tower-wa", "send", BOX, true]);
	assert.deepEqual(parseWorker(String(r!.body.text)), { spec: { label: "MP-1", branch: "fix/mp-1", model: "openai-codex/gpt-6.2-astra", points: 2 }, brief: "Fix MP-1. Anchor: npm test." });
	const [a] = asks.openOf("wA");
	assert.deepEqual([a!.ask, a!.for, a!.tower, a!.device], [r!.body.awaitsReply, "main-1", "sb-tower-wa", BOX]);
	assert.ok(a!.expires >= before + WORKER_ASK_KEEP_MS);
	assert.match(String(sent.text), /Its answer comes to you as a link_reply/);
});

test("refused, with nothing sent: a box with no tower.worker, a member, a worker, a reserved branch, and an empty brief", async () => {
	const off = rig(["tower.wait"]);
	assert.match(String((await off.hub.op(op({ branch: "fix/a" }), "main-1")).error), /opens no workers/);
	const { hub, requests } = rig(["tower.worker"]);
	assert.match(String((await hub.op(op({ branch: "fix/a" }), "member-1")).error), /Only a main of this computer that is no worker/);
	assert.match(String((await hub.op(op({ branch: "fix/a" }), "w-1")).error), /that is no worker/);
	assert.match(String((await hub.op(op({ branch: "main" }), "main-1")).error), /integration or train branch/);
	assert.match(String((await hub.op(op({ branch: "fix/a" }, " "), "main-1")).error), /needs a brief/);
	assert.equal(off.requests.length + requests.length, 0);
});
