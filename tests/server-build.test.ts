import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error the build script is plain JavaScript
import { buildServer, FORBIDDEN } from "../scripts/build-server.mjs";

// docs/specs/2026-10-26-sb-backend.md, What the server runs from: the server is prebuilt to dist/server/*.mjs, and the build fails when the bundle still imports pi's
// own packages (they are not on disk when pi installs the package, so a plain `node` could not load them).

const root = fileURLToPath(new URL("..", import.meta.url));
let scratch = "";
beforeEach(() => void (scratch = mkdtempSync(join(tmpdir(), "psb-build-"))));
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

test("the real entries build to main.mjs and cli.mjs with no import of pi's packages, and cli.mjs runs under plain node", async () => {
	const outdir = join(root, "dist", `server-test-${process.pid}`);
	try {
		await buildServer({ outdir });
		const files = readdirSync(outdir);
		assert.ok(files.includes("main.mjs") && files.includes("cli.mjs"), files.join(", "));
		for (const file of files) {
			const text = readFileSync(join(outdir, file), "utf8");
			for (const name of FORBIDDEN) assert.ok(!text.includes(`"${name}"`), `${file} imports ${name}`);
		}
		// A shell with nothing of pi's in its environment. (This folder sits in the checkout, whose node_modules is on the resolution path: the packaged test, tests/server-packaged.test.ts, runs the install layout.)
		const env = { PATH: process.env.PATH ?? "", HOME: scratch, PI_CODING_AGENT_DIR: join(scratch, "agent") };
		const status = JSON.parse(execFileSync(process.execPath, [join(outdir, "cli.mjs"), "status"], { env, encoding: "utf8" })) as { state: string; package: string };
		assert.equal(status.state, "gone");
		assert.equal(status.package, (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version);
	} finally {
		rmSync(outdir, { recursive: true, force: true });
	}
});

async function fixture(name: string, source: string) {
	mkdirSync(join(scratch, "src"), { recursive: true });
	writeFileSync(join(scratch, "src", `${name}.ts`), source);
	return buildServer({ root: scratch, entries: { [name]: `src/${name}.ts` }, outdir: join(scratch, "out") });
}

test("the build fails when a module the server loads imports pi-tui, typebox, or pi-coding-agent as a value, and names the module", async () => {
	for (const name of FORBIDDEN) {
		await assert.rejects(fixture("bad", `import { thing } from "${name}";\nexport const x = thing;\n`), (error: Error) => error.message.includes(`src/bad.ts imports ${name}`) && /not on disk/.test(error.message), name);
	}
	await assert.rejects(fixture("bad2", `import { Type } from "typebox/value";\nexport const x = Type;\n`), /src\/bad2\.ts imports typebox\/value/);
	await assert.rejects(fixture("bad3", `export const load = () => import("typebox");\n`), /src\/bad3\.ts imports typebox/);
	assert.deepEqual(readdirSync(scratch).filter((f) => f === "out"), [], "a failed build leaves no bundle behind");
});

test("sbr-F006: an inline type import (import { type X } from \"typebox\") leaves a side-effect import of the package behind, so the build fails on it; the fix is `import type`", async () => {
	await assert.rejects(fixture("inline", `import { type TSchema } from "typebox";\nexport const x = (s: TSchema) => s;\n`), /src\/inline\.ts imports typebox/);
	await assert.rejects(fixture("inline2", `import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";\nexport const x = (a: ExtensionAPI) => a;\n`), /src\/inline2\.ts imports @earendil-works\/pi-coding-agent/);
});

test("type imports of those packages are fine: they leave no import behind", async () => {
	await fixture("ok", `import type { TSchema } from "typebox";\nimport type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\nexport const x = (s: TSchema, a: ExtensionAPI) => [s, a];\n`);
	assert.ok(readdirSync(join(scratch, "out")).includes("ok.mjs"));
});

test("tsx is not bundled: the server resolves it at runtime from its own package", async () => {
	await fixture("loader", `export const find = () => import("tsx/esm/api");\n`);
	assert.match(readFileSync(join(scratch, "out", "loader.mjs"), "utf8"), /tsx\/esm\/api/);
});
