import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import strawBoss, { createStrawBoss } from "../src/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

// Pi reloads extension TypeScript on /reload, but Node caches native .js/.mjs modules for the
// life of the process. A relative JavaScript import would keep an old version after an upgrade.
test("extension code imports relative modules only as .ts", () => {
	for (const name of readdirSync(join(root, "src")).filter((file) => file.endsWith(".ts"))) {
		for (const [, specifier] of readFileSync(join(root, "src", name), "utf8").matchAll(/from\s+["'](\.[^"']*)["']/g)) {
			assert.match(specifier ?? "", /\.ts$/, `src/${name} imports ${specifier}`);
		}
	}
});

test("the module loads, its factory runs, and outside Herdr it registers nothing", () => {
	assert.equal(typeof strawBoss, "function");
	const registered: string[] = [];
	const pi = { on: (type: string) => registered.push(type), registerTool: () => registered.push("tool"), registerCommand: () => registered.push("command") };
	createStrawBoss({ env: {} })(pi as never);
	assert.deepEqual(registered, []);
});

test("the manifest ships only src, the built GUI bundle, prompts, README, NOTICE (the QR encoder's MIT notice), and LICENSE, has no runtime dependencies, builds the bundle before packing and testing, and points at a real entry", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.deepEqual(manifest.files, ["src", "dist/gui", "prompts", "README.md", "NOTICE.md", "LICENSE"]);
	assert.equal(manifest.dependencies, undefined);
	assert.ok(manifest.devDependencies.vite, "the page is built with Vite, as a development dependency only");
	assert.equal(manifest.scripts.prepack, "npm run gui:build");
	assert.equal(manifest.scripts.pretest, "npm run gui:build");
	assert.ok(manifest.keywords.includes("pi-package"));
	assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "*");
	for (const entry of manifest.pi.extensions) assert.ok(existsSync(join(root, entry)), entry);
});

test("the TypeScript source stays within its size budgets", () => {
	const count = (path: string) => readFileSync(join(root, path), "utf8").trimEnd().split("\n").length;
	const names = (dir: string) => readdirSync(join(root, dir)).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"));
	const sum = (dir: string, list: string[]) => list.reduce((total, name) => total + count(`${dir}/${name}`), 0);
	// The dashboard, the browser view's server and data code, and the session reader each have a budget of their own so the coordination code stays readable on its own.
	assert.ok(count("src/dashboard.ts") <= 200, `src/dashboard.ts has ${count("src/dashboard.ts")} lines`);
	// 0.5.0 raised the server's figure from 300 to 320 for the CSRF meta, the POST routing into control.ts, and the remote access check (pairing, remote streams);
	// 0.6.0 to 325 for the hub's start and stop with the server, the answer route's fresh reading, gui.json's ownerSession, and the sessions a reading binds dialogs with.
	assert.ok(sum("src", ["net.ts", "gui.ts"]) <= 325, `src/net.ts and src/gui.ts have ${sum("src", ["net.ts", "gui.ts"])} lines`);
	// Input (the spec's figure), remote access over Tailscale, its terminal pairing panel (QR, c copies, o opens), and the QR encoder each have their own.
	// What a waiting session waits on (0.5.0, read for display only; answering is deferred) has its own as well.
	// 0.5.1 raised remote.ts from 165 to 185 (a recorded server counts as running only if its process started when the entry says: a reused PID
	// is not the owner) and ask.ts from 80 to 115 (the current branch's path instead of a line scan, a window that grows for a long call, and ask_user_question's list of questions).
	// 0.6.0 raised ask.ts from 115 to 125 to join relayed dialogs to what the file says (a unit with one waits before Herdr says blocked).
	// The dialog bridge (in every session), the owner adapters, and the hub have the spec's own figures; owners.ts is 120 instead of 90 because
	// rpiv-ask-user-question replaced pi-ask-user and speaks its own channel (prompt, answer, verdict codes, blocked), which its adapter maps.
	for (const [name, max] of [["control.ts", 150], ["remote.ts", 185], ["pairing.ts", 60], ["qr.ts", 140], ["ask.ts", 125], ["bridge.ts", 170], ["owners.ts", 120], ["dialogs.ts", 160]] as const) assert.ok(count(`src/${name}`) <= max, `src/${name} has ${count(`src/${name}`)} lines`);
	assert.ok(count("src/history.ts") <= 250, `src/history.ts has ${count("src/history.ts")} lines`);
	// The item mapping and the stream glue came out of the reader to keep it within its budget; the spec sets no figure for them.
	assert.ok(count("src/items.ts") <= 100, `src/items.ts has ${count("src/items.ts")} lines`);
	assert.ok(count("src/watch.ts") <= 90, `src/watch.ts has ${count("src/watch.ts")} lines`);
	// Pane balance is a separate extension entry with its plain-JavaScript helper.
	assert.ok(count("src/balance.ts") + count("src/balance.mjs") <= 220, "src/balance.ts and src/balance.mjs stay small");
	// The rpiv-ask-user-question blocked relay is its own extension entry too.
	assert.ok(count("src/blocked.ts") <= 25, "src/blocked.ts stays small");
	const apart = ["dashboard.ts", "net.ts", "gui.ts", "history.ts", "items.ts", "watch.ts", "balance.ts", "control.ts", "remote.ts", "pairing.ts", "qr.ts", "ask.ts", "blocked.ts", "bridge.ts", "owners.ts", "dialogs.ts"];
	const rest = sum("src", names("src").filter((name) => !apart.includes(name)));
	// 0.4.1 raised it from 540 to 575 for claiming and promotion; 0.5.0 to 610 for herdrCall (Herdr's answers with their error codes, spec task 4) and the /boss gui remote command;
	// 0.5.1 to 620 for a join retry that follows its session to another tab; 0.6.0 to 630 to start the dialog bridge before the subagent return and the hub with the server.
	assert.ok(rest <= 630, `the rest of src has ${rest} lines`);
	// The page: the files the spec budgets one by one, then this round's own figures (no figure in the spec): the focus views, the overlay
	// layer (alert spotting and the stack model in the map's chunk, the layer's DOM and tiles in a chunk of their own), the dev-only demo, and everything else.
	for (const [name, max] of [["router.ts", 80], ["chat.ts", 250], ["markdown.ts", 180], ["views.ts", 245], ["layer.ts", 175], ["composer.ts", 165], ["ask.ts", 152]] as const) assert.ok(count(`gui/${name}`) <= max, `gui/${name} has ${count(`gui/${name}`)} lines`);
	// 0.5.0 raised views.ts from 240 to 245 and layer.ts from 150 to 165 for the read-only question panel (gui/ask.ts) in the session view and
	// in alert dialogs, and layer.ts also for raising a dialog that peeks out beneath the top one.
	// The composer's figure was the spec's 120; 0.5.0 raised it to 125 so a send in flight outlives a composer the route replaced (review R-1);
	// 0.5.1 to 165 for the note a send leaves when no composer is there to say it (a refusal's reason, an edit of text that already went) and the three pure rules around it.
	// 0.5.1 raised layer.ts from 165 to 175: dialogs of units that left the net, one queue count in the header and every dialog, a click that really hit a control.
	// The answer panel's figure was 130; 0.6.0 raised it to 140 for a panel that belongs to its dialog, so the net's updates leave what the user picked, typed, and noted;
	// 0.6.1 to 152 for a panel refused as busy that answers again once the other answer was refused, an outcome that lingers six seconds from the
	// unit's leaving instead of from the latest update, and a focus that comes back to the control a disconnect or a Send on its way disabled (unless the user went elsewhere).
	// The comms log's scroll rules (pinned to the end, reaching an anchor) are pure and live beside it.
	assert.ok(count("gui/follow.ts") <= 50, `gui/follow.ts has ${count("gui/follow.ts")} lines`);
	const overlay = sum("gui", ["alerts.ts", "overlay.ts"]);
	// 0.5.0 raised it from 110 to 115: dialogs the user did not open go beneath the top one, and alerts carry the question;
	// 0.5.1 to 125 for the queue count in words, a dialog whose unit left the net, and redraw.
	assert.ok(overlay <= 125, `the overlay model has ${overlay} lines`);
	const demo = sum("gui", ["fixture.ts", "demo-chat.ts"]);
	// 0.5.0 raised it from 160 to 165 for a demo question and a demo secret; 0.6.0 to 170 for a demo robot_hand selector and questionnaire that answer;
	// 0.6.1 to 174 for a demo tool call whose arguments show cut (with the whole of them for "show all arguments"), an answerable dialog that stays
	// until it is answered, and a toolbar that folds to a tab in the margin on a phone.
	assert.ok(demo <= 174, `the demo fixture has ${demo} lines`);
	// The phone pairing tile and the write helper it shares with the composer (0.5.0, no figure in the spec).
	const pairing = sum("gui", ["pair.ts", "post.ts"]);
	assert.ok(pairing <= 50, `the pairing tile has ${pairing} lines`);
	const shipped = new Set(["router.ts", "chat.ts", "follow.ts", "markdown.ts", "views.ts", "layer.ts", "alerts.ts", "overlay.ts", "fixture.ts", "demo-chat.ts", "composer.ts", "pair.ts", "post.ts", "ask.ts"]);
	const page = sum("gui", names("gui").filter((name) => !shipped.has(name)));
	assert.ok(page <= 540, `the page's TypeScript has ${page} lines`);
});

test("the built page is small, self-contained (no remote URLs, fonts, or imports), and carries no demo fixture", { skip: !existsSync(join(root, "dist/gui/index.html")) && "run npm run gui:build first" }, () => {
	const dir = join(root, "dist/gui");
	const files = [join(dir, "index.html"), ...readdirSync(join(dir, "assets")).map((name) => join(dir, "assets", name))];
	const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
	const remote = [...text.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]).filter((url) => url !== "http://www.w3.org/2000/svg");
	assert.deepEqual(remote, [], "nothing is fetched from elsewhere");
	assert.ok(!/@import|<link[^>]+href="https?:/.test(text));
	assert.ok(!text.includes("Harbor API") && !text.includes("demo fixture") && !text.includes("harbor-1"), "the demo fixture stays out of the bundle");
	assert.ok(/EventSource/.test(text), "the built page reads the live stream");
	assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML/.test(text), "no page code writes markup");
	// Budgets from the spec: the map's JavaScript, the lazy chunks together (views, chat with markdown, the overlay layer), and the stylesheet, raw and gzipped.
	const assets = readdirSync(join(dir, "assets")), size = (name: string) => readFileSync(join(dir, "assets", name)), gz = (name: string) => gzipSync(size(name)).length;
	const entry = /assets\/(index-[\w-]+\.js)/.exec(readFileSync(join(dir, "index.html"), "utf8"))?.[1];
	assert.ok(entry, "index.html loads one entry script");
	const chunks = assets.filter((name) => name.endsWith(".js") && name !== entry), css = assets.filter((name) => name.endsWith(".css"));
	const total = (list: string[], measure: (name: string) => number) => list.reduce((sum, name) => sum + measure(name), 0);
	assert.ok(size(entry).length <= 15_000 && gz(entry) <= 6_000, `the map chunk is ${size(entry).length} bytes (${gz(entry)} gzipped)`);
	// The lazy chunks' gzip figure was 12 KB; 0.5.0 raised it to 14 KB for the composer (about 2.2 KB gzipped) and the phone pairing tile with its POST helper (about 1.1 KB).
	// The question panel (0.5.0, read-only, about 0.7 KB gzipped) and its place in the dialogs and the session view raised the gzip figure to 15.5 KB;
	// 0.5.1 to 36.5 KB / 16.2 KB for the composer's note and the dialogs of units that left the net (about 0.7 KB gzipped together).
	// 0.6.0 to 40 KB / 17.5 KB for the answer panel (gui/ask.ts: a select with notes and Copy command, questionnaires with own words and notes, outcomes and Check again; about 1.2 KB gzipped),
	// and to 40.5 KB raw for a panel that belongs to its dialog across the net's updates (about 0.5 KB, 0.1 KB gzipped).
	// 0.6.1 to 40.9 KB / 17.8 KB for the panel's busy, linger, and focus fixes and the tool card's "show all arguments" (about 0.35 KB, 0.26 KB gzipped).
	assert.ok(chunks.length >= 1 && total(chunks, (n) => size(n).length) <= 40_900 && total(chunks, gz) <= 17_800, `the chat chunks are ${total(chunks, (n) => size(n).length)} bytes (${total(chunks, gz)} gzipped)`);
	// The stylesheet's figure was 22 KB / 6 KB; 0.4.0 raised it by 0.1 KB for the comms anchor highlight, the receive-only strip, and the title link;
	// 0.5.0 to 24.6 KB / 6.7 KB for the composer, the phone layout with its touch targets and safe-area insets, and the pairing tile.
	// and to 26 KB / 7 KB for the read-only question panel and the net log that folds on a phone; 0.5.1 to 26.5 KB raw for the queue line in the dialogs.
	// 0.6.0 to 27.5 KB / 7.25 KB for the answer panel's toggles, fields, and Send.
	assert.ok(total(css, (n) => size(n).length) <= 27_500 && total(css, gz) <= 7_250, `the stylesheet is ${total(css, (n) => size(n).length)} bytes (${total(css, gz)} gzipped)`);
});
