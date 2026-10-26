import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { findIntercomDir, findTsx, loadIntercom, LoaderError, MIN_INTERCOM } from "../src/server/intercom.ts";

// docs/specs/2026-10-26-sb-backend.md, What the server runs from: the server finds tsx from its own package and pi-intercom beside it, and loads pi-intercom's client through
// tsx's scoped tsImport. These tests use a real layout in a temp folder, and tsx for real.

let base = "";
beforeEach(() => void (base = mkdtempSync(join(tmpdir(), "psb-ic-"))));
afterEach(() => rmSync(base, { recursive: true, force: true }));

const put = (file: string, text: string) => (mkdirSync(join(file, ".."), { recursive: true }), writeFileSync(file, text));
/** pi's npm layout: pi-straw-boss and pi-intercom side by side in node_modules; pi-intercom's modules are TypeScript, as it ships them. */
function layout(version = MIN_INTERCOM) {
	const nodeModules = join(base, "agent", "npm", "node_modules"), root = join(nodeModules, "pi-straw-boss"), intercom = join(nodeModules, "pi-intercom");
	put(join(root, "package.json"), JSON.stringify({ name: "pi-straw-boss", version: "0.0.0" }));
	put(join(intercom, "package.json"), JSON.stringify({ name: "pi-intercom", version }));
	put(join(intercom, "broker", "client.ts"), "let made: number = 0;\nexport class IntercomClient { id: number = ++made; }\n");
	put(join(intercom, "broker", "spawn.ts"), "export const spawned: string[][] = [];\nexport async function spawnBrokerIfNeeded(command: string, args: string[]): Promise<void> { spawned.push([command, ...args]); }\n");
	put(join(intercom, "config.ts"), "export function loadConfig(): { brokerCommand: string; brokerArgs: string[] } { return { brokerCommand: 'broker', brokerArgs: ['--x'] }; }\n");
	return { root, intercom, env: { PI_CODING_AGENT_DIR: join(base, "agent") } as NodeJS.ProcessEnv };
}

test("findIntercomDir finds pi-intercom beside the package, and STRAW_BOSS_INTERCOM first", () => {
	const l = layout();
	assert.deepEqual(findIntercomDir(l.env, l.root), { dir: l.intercom, version: MIN_INTERCOM });
	const other = join(base, "elsewhere");
	put(join(other, "package.json"), JSON.stringify({ version: "0.19.0" }));
	put(join(other, "broker", "client.ts"), "");
	assert.deepEqual(findIntercomDir({ ...l.env, STRAW_BOSS_INTERCOM: other }, l.root), { dir: other, version: "0.19.0" });
});

test("findIntercomDir refuses a pi-intercom older than the minimum, one without a readable version, and one that is not there, as an intercom LoaderError", () => {
	const old = layout("0.17.1");
	assert.throws(() => findIntercomDir(old.env, old.root), (e: unknown) => e instanceof LoaderError && e.code === "intercom" && /0\.17\.1.*older than 0\.18\.1/.test(e.message));
	writeFileSync(join(old.intercom, "package.json"), "not json");
	assert.throws(() => findIntercomDir(old.env, old.root), (e: unknown) => e instanceof LoaderError && e.code === "intercom" && /version could not be read/.test(e.message));
	rmSync(join(old.intercom, "broker"), { recursive: true });
	assert.throws(() => findIntercomDir(old.env, old.root), (e: unknown) => e instanceof LoaderError && e.code === "intercom" && /was not found/.test(e.message));
});

test("findTsx resolves tsx/esm/api from the package's own place, and a place with no tsx above it is a loader LoaderError naming it", () => {
	assert.match(findTsx(), /tsx[\\/]dist[\\/]esm[\\/]api/);
	const lonely = join(base, "no", "tsx", "here", "file.mjs");
	assert.throws(() => findTsx(lonely), (e: unknown) => e instanceof LoaderError && e.code === "loader" && e.message.includes(lonely));
});

test("loadIntercom loads pi-intercom's three modules through tsx once, however often it connects; each connect starts the broker and makes a new client", async () => {
	const l = layout();
	const mod = await loadIntercom({ env: l.env, root: l.root });
	assert.equal(mod.version, MIN_INTERCOM);
	const first = await mod.connect(), second = await mod.connect(), third = await mod.connect();
	assert.notEqual(first, second);
	assert.equal(Object.getPrototypeOf(first), Object.getPrototypeOf(second), "the same module instance, so no hook and no copy per attempt");
	assert.equal(Object.getPrototypeOf(second), Object.getPrototypeOf(third));
	assert.deepEqual([first, second, third].map((c) => (c as unknown as { id: number }).id), [1, 2, 3], "one module instance counted all three");
});

test("loadIntercom with a counting loader: three modules once, the broker started at every connect, and a failed load is tried again", async () => {
	const l = layout();
	const loads: string[] = [];
	let started = 0, fail = true;
	const tsImport = async (specifier: string) => {
		loads.push(specifier.replace(/^.*pi-intercom\//, ""));
		if (fail) throw new Error("disk hiccup");
		if (specifier.endsWith("client.ts")) return { IntercomClient: class {} };
		if (specifier.endsWith("spawn.ts")) return { spawnBrokerIfNeeded: async () => void started++ };
		return { loadConfig: () => ({ brokerCommand: "b", brokerArgs: [] }) };
	};
	const mod = await loadIntercom({ env: l.env, root: l.root, tsImport });
	await assert.rejects(mod.connect(), /disk hiccup/);
	fail = false;
	loads.length = 0;
	await mod.connect();
	await mod.connect();
	await mod.connect();
	assert.deepEqual([...loads].sort(), ["broker/client.ts", "broker/spawn.ts", "config.ts"], "each module loaded once");
	assert.equal(started, 3);
});
