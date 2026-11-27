import assert from "node:assert/strict";
import { test } from "node:test";
import { createCarClient } from "../src/traincar.ts";

// ward-review F011: train_car's client, its background check, and sb_ward's client share one secret store and one registration in flight per process. A refusal of an old secret that arrives after a new secret was written
// does not erase the new one. A fake server: it knows the secrets it handed since its last restart, and refuses a second registration of a live process.

function server() {
	let n = 0, known = new Set<string>(), registered = false;
	const calls: Record<string, unknown>[] = [];
	const late: { release?: () => void } = {};
	const call = async (request: Record<string, unknown>) => {
		calls.push(request);
		if (request.cmd === "cars-register") {
			if (registered) return { ok: false, error: "sb: session s1 is already registered to a live process" };
			registered = true;
			const secret = `sec-${++n}`;
			known.add(secret);
			return { ok: true, secret };
		}
		const ok = known.has(String(request.secret));
		// `late`: this request's answer waits until the test lets it go (a refusal that arrives late).
		if (request.cmd === "cars-read" && late.release === undefined && request.late) await new Promise<void>((r) => (late.release = r));
		return ok ? { ok: true, cars: [] } : { ok: false, error: "sb: this request is not from a registered session" };
	};
	return { call, calls, late, restart: () => void ((known = new Set()), (registered = false)) };
}

test("F011: two clients of one process register once, and a late refusal of the old secret keeps the new one", async () => {
	const s = server(), held = new Map<string, string>();
	const deps = { call: s.call, session: () => "s1", pane: () => "p1", pid: 4242, started: () => "t0", held };
	const train = createCarClient(deps), ward = createCarClient(deps);
	assert.deepEqual(await Promise.all([train.ensure(), ward.ensure()]), ["sec-1", "sec-1"]);
	assert.equal(s.calls.filter((c) => c.cmd === "cars-register").length, 1, "one registration in flight per process");
	s.restart();
	// sb_ward's request goes out with the old secret; its refusal comes back only after train_car's check registered again.
	const old = await ward.ensure();
	const pending = s.call({ cmd: "cars-read", secret: old, late: true });
	while (!s.late.release) await new Promise<void>((r) => setImmediate(r));
	assert.equal(await train.verify(), true);
	assert.equal(held.get("s1|4242"), "sec-2");
	s.late.release();
	assert.equal((await pending).ok, false);
	ward.forget(old);
	assert.equal(held.get("s1|4242"), "sec-2", "the new secret is kept");
	assert.equal(await ward.ensure(), "sec-2");
	assert.deepEqual(await train.read("proj"), []);
	assert.equal(s.calls.filter((c) => c.cmd === "cars-register").length, 2);
});
