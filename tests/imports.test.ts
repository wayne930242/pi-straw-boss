import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
	// 0.6.0 to 325 for the hub's start and stop with the server, the answer route's fresh reading, gui.json's ownerSession, and the sessions a reading binds dialogs with;
	// 0.7.0 to 330 for the terminal mirror (Phase 3 task 1): each stream's `hello` with its id, and the mirrors it holds created, closed with it, and stopped with the server.
	// 0.8.0 to the Phase 3 plan's 335 for documents: a unit's documents in the snapshot (task 6), the document routes' dispatch and the app's frame-src (task 7).
	// 0.10.1 to 336 for the bundle read whole at start, so a package update under a running server leaves its page's assets in place.
	// 0.11.0 to 377 for any session reaching the one server: the stop request and its wait (requestStop), the takeover in sharedGui, the version
	// and reload mark gui.json keeps (newer, markReload), the server's own stop for onStop, and the build named in the page and each hello.
	// 0.18.0 to 379 for the font: its type, and a cache that keeps it (its name carries its hash).
	// 0.20.0 to 386 for a unit's queue (Queued) and the image route, with its cache for entries that never change.
	assert.ok(sum("src", ["net.ts", "gui.ts"]) <= 386, `src/net.ts and src/gui.ts have ${sum("src", ["net.ts", "gui.ts"])} lines`);
	// Input (the spec's figure), remote access over Tailscale, its terminal pairing panel (QR, c copies, o opens), and the QR encoder each have their own.
	// What a waiting session waits on (0.5.0, read for display only; answering is deferred) has its own as well.
	// 0.5.1 raised remote.ts from 165 to 185 (a recorded server counts as running only if its process started when the entry says: a reused PID
	// is not the owner) and ask.ts from 80 to 115 (the current branch's path instead of a line scan, a window that grows for a long call, and ask_user_question's list of questions).
	// 0.6.0 raised ask.ts from 115 to 125 to join relayed dialogs to what the file says (a unit with one waits before Herdr says blocked).
	// The sort key and sidebar marks of the net members (order.ts) are the sidebar plugin's data, kept apart from the coordination code.
	// 0.6.10 raised order.ts from 75 to 80 for `sb_indent`, the branch a subagent hangs on (its two glyphs and the check for a later marked sibling).
	// Unreleased raised it from 80 to 81 for `sb_name`, the subagent's own name: its line in the token list; the writes and the clear fit the lines they were on.
	// The dialog bridge (in every session), the owner adapters, and the hub have the spec's own figures; owners.ts is 120 instead of 90 because
	// rpiv-ask-user-question replaced pi-ask-user and speaks its own channel (prompt, answer, verdict codes, blocked), which its adapter maps.
	// The terminal mirror's reader (0.7.0) has the Phase 3 plan's figure, and so does the bridge's editor check (probe.ts, task 3), which
	// raised bridge.ts from 170 to 190 (the probe message, following gui.json from the start, the server's pid check) and dialogs.ts from
	// 160 to 185 (the probe sent and awaited for 1 s, and the bridges every reading binds by pane and file). The key pad's guards (keys.ts, task 4)
	// have the plan's 80; they came out of control.ts, which keeps only the dispatch. The mirror's reader is 135, not the plan's 130: it drops
	// the blanks Herdr pads every row with, which made a scrolling screen 12.8 KB/s against the plan's 12 (live check A1).
	// The document contract (documents.ts, Phase 3 task 6) has the plan's 60 plus 20: the hub's capabilities (minted per document and server, kept while a
	// bridge lists the document) live beside the adapter instead of in dialogs.ts. The plan's 190 for bridge.ts and 185 for dialogs.ts were to cover the
	// documents too, but the probe (task 3) took both; 0.8.0 raises bridge.ts to 195 (the documents in the message, cut first and counted in bytes, and the
	// form answer handed to the owner) and dialogs.ts to 210 (the documents checked in each relay apart from the dialogs, bound with the dialog rule, a
	// capability looked up in the bridge's current list, and the form answer checked, sent, and awaited for 5 s, with the three waits sharing one helper).
	// Document serving (docs.ts, task 7) has the plan's 150.
	// The tower's opening of a main (opener.ts, unreleased) has no figure in a spec: the sender check, the tab and its pi, the wait for the pi's role, the handoff text,
	// the close of a tab that failed, and the once-per-request memory. Raised 75 to 90 for the limits (review R-F001): the live-pane count per workspace and per sender,
	// the marker on the new pane, the serialising queue, and the refusal texts.
	// The orphan nudge (orphan.ts, 0.8.0) is a watcher of its own with no figure in a spec: what the registry and the transcript say about a finished child,
	// the debounce, the give-up counts, the check that the pane runs the child's own launch script (a pane that only reuses its session file, a resumed run
	// or a pi someone started there, is not the child), and the one message. Its session wiring is in index.ts, and its tests (tests/orphan.test.ts) own the rest.
	// The watch on the Herdr server (server-watch.ts, unreleased) has no figure in a spec: one subscription connection whose closing says a new server took over, the
	// acknowledgement read off the socket, the retry ladder, and the stop. Its wiring in index.ts is counted with the rest below.
	// 0.11.0 raised control.ts from 150 to 156 for server/stop: another session's stop or takeover, checked like every write, never from a paired device.
	// 0.12.0 to 163 for remote/on: the pairing tile turns remote access on from the page and answers with a code, or why it could not.
	// 0.13.0 to 165 for dirs and open/*, handed to spawn.ts (the folder picker, a new main, a new base with its tower), which has its own budget.
	// 0.14.0 raised control.ts to 172 for the `/` menu's read (sessions/<key>/commands: a prefix checked, the hub asked, no Herdr call), bridge.ts to 198
	// for answering it with the session's matching commands, and dialogs.ts to 213 for the hub's request (probe and commands now share one helper);
	// the listing and its check are src/commands.ts, 32 at most.
	// 0.15.0 raised control.ts to 176 for sessions/<key>/upload, a file's bytes under the same origin and CSRF checks, handed to upload.ts (50 at most).
	// 0.15.0 raised spawn.ts from 123 to 168: a base opens with a member and no tower, a base without a tower takes members (split into a squad or in
	// a new tab), only one with a tower takes mains, and every opening shares the start, join wait, first message, and close-on-failure.
	// 0.17.2 raised server-watch.ts to 110 for herdrEvents, the event stream the tower guard listens to.
	// 0.17.0 raised bridge.ts to 206 for `close`, the session asked to quit as /boss close does, and its answer.
	// 0.17.0 raised dialogs.ts to 217 for the hub's side of `close`: the request, its answer, and its drop when the server stops.
	// 0.17.0 raised control.ts to 178 for close/unit, close/tab, close/base, handed to closer.ts (70 at most).
	for (const [name, max] of [["commands.ts", 32], ["control.ts", 178], ["closer.ts", 70], ["upload.ts", 50], ["spawn.ts", 168], ["remote.ts", 185], ["pairing.ts", 60], ["qr.ts", 140], ["ask.ts", 127], ["bridge.ts", 237], ["owners.ts", 120], ["dialogs.ts", 220], ["order.ts", 81], ["mirror.ts", 135], ["probe.ts", 40], ["keys.ts", 80], ["documents.ts", 80], ["docs.ts", 150], ["orphan.ts", 115], ["opener.ts", 90], ["server-watch.ts", 110]] as const) assert.ok(count(`src/${name}`) <= max, `src/${name} has ${count(`src/${name}`)} lines`);
	// 0.19.0 to 258 for the todo list: rpiv-todo's snapshots marked as the index reads them, and the newest one read for a reset or a change that adds one.
	assert.ok(count("src/history.ts") <= 258, `src/history.ts has ${count("src/history.ts")} lines`);
	// The item mapping and the stream glue came out of the reader to keep it within its budget; the spec sets no figure for them.
	// 0.19.0 to 108 for Todo and todosOf, a todo snapshot checked field by field.
	assert.ok(count("src/items.ts") <= 108, `src/items.ts has ${count("src/items.ts")} lines`);
	// 0.20.0 to 106 for an entry's images served one by one as their bytes (image).
	assert.ok(count("src/watch.ts") <= 106, `src/watch.ts has ${count("src/watch.ts")} lines`);
	// Pane balance is a separate extension entry with its plain-JavaScript helper.
	assert.ok(count("src/balance.ts") + count("src/balance.mjs") <= 220, "src/balance.ts and src/balance.mjs stay small");
	// The blocked relay (rpiv-ask-user-question, and pi's own dialog prompts) is its own extension entry too. It was 25 lines for the rpiv relay alone;
	// the dialog relay raised it to 42 for the label of a dialog's title and the signed count that keeps the pairs balanced when pi delivers an end ahead of its start, and the guard for an end that reaches a retired runtime.
	assert.ok(count("src/blocked.ts") <= 42, "src/blocked.ts stays small");
	const apart = ["commands.ts", "dashboard.ts", "net.ts", "gui.ts", "history.ts", "items.ts", "watch.ts", "balance.ts", "control.ts", "remote.ts", "pairing.ts", "qr.ts", "ask.ts", "blocked.ts", "bridge.ts", "owners.ts", "dialogs.ts", "order.ts", "mirror.ts", "probe.ts", "keys.ts", "documents.ts", "docs.ts", "orphan.ts", "opener.ts", "spawn.ts", "upload.ts", "closer.ts", "server-watch.ts"];
	const rest = sum("src", names("src").filter((name) => !apart.includes(name)));
	// 0.4.1 raised it from 540 to 575 for claiming and promotion; 0.5.0 to 610 for herdrCall (Herdr's answers with their error codes, spec task 4) and the /boss gui remote command;
	// 0.5.1 to 620 for a join retry that follows its session to another tab; 0.6.0 to 630 to start the dialog bridge before the subagent return and the hub with the server.
	// 0.7.0 to 650 for the order and mark tokens each session publishes with its role (order.ts, which has its own figure), the tab list they read,
	// and one publish at a time that shutdown waits for. 0.6.10 to 661: the role marks moved from order.ts to herdr.ts beside the tower label, so the
	// dashboard draws the sidebar's glyphs without importing order.ts, which imports the dashboard, and the towerModel setting (read at each tower
	// start and passed to pi as --model); 0.8.0 to 667 to mark a launched subagent within seconds of the launch, and to 681 for the orphan nudge's wiring
	// in index.ts (the watcher started at session start and stopped at shutdown, its few lines of state, the polling interval as a dependency tests can shorten)
	// and for the message id every send carries (a nonce per process: a restarted pi keeps its session id, and pi-intercom refuses a reused id with other content).
	// Unreleased: to 712 for the tower opening a main (opener.ts, which has its own figure): index.ts registers boss_open_main in the tower (its schema and texts, 18 lines)
	// and makes a pi started with STRAW_BOSS_ROLE=main promote itself after joining (4 lines); herdr.ts gained createTab and startPi, which the tower's own opening now shares (9 lines net). Raised 712 to 723 (review R-F001/R-F002) for index.ts claiming the one-time pane token and keeping the opener's marker fresh (11 lines). Raised 723 to 739 for the tower tab's lifecycle: a quitting tower closes its own tab when the tab holds only its pane (index.ts, 6 lines), and opening adopts a token-less leftover tab and closes surplus ones (herdr.ts, 10 lines). Raised 739 to 743 (review R-F001 on the leftover-tab fix): an adopted shell that stays busy gives its tower token back when pi cannot start in it. Raised 743 to 760 for the takeover wiring in index.ts (17 lines): the `watch` dependency, `restore` (the tower's marks first, then the full publish), and the watch started where a session joins and stopped at session start and shutdown. Raised 760 to 767 for Tab completion after /boss (index.ts, 7 lines): the subcommands with their descriptions and the getArgumentCompletions that filters them.
	// 0.11.0 to 783 for /boss gui from any session (index.ts, 16 lines): stop asks the running server, remote and remote off take it over first,
	// the owner's stop through onStop says who stopped it, and session start brings back the server a /reload or /new stopped (after a /new, once the new session's id shows) or takes over an older one.
	// 0.13.0 to 784 for the opening API (spawn.ts, which has its own figure): index.ts hands it to the GUI with the tower opening it reuses (1 line).
	// 0.17.0 to 855 for the tower and the mains going together (index.ts): the guard that promotes under a live tower, clears the mains when it quits or
	// stays gone past a /reload's grace, and opens a base's tower by its own rule (two members while another base has one); and closing (/boss close and
	// the bridge's close: quit as /quit, then the pane closes after pi has exited).
	// 0.17.1 to 857: a quitting tower records the members it leaves, and the two-member rule waits for the base to grow past them.
	// 0.17.2 to 885: the guard checks on Herdr's events (a workspace's tokens, this workspace's panes, the tab channel's owner) instead of every
	// 5 s, sets one timer for a check that has to wait, runs one check at a time, and can be left out (couple) where a test is about something else.
	assert.ok(rest <= 885, `the rest of src has ${rest} lines`);
	// The page: the files the spec budgets one by one, then this round's own figures (no figure in the spec): the focus views, the overlay
	// layer (alert spotting and the stack model in the map's chunk, the layer's DOM and tiles in a chunk of their own), the dev-only demo, and everything else.
	// 0.18.1 raised mirror.ts to 154 for embed, a terminal shown inside the session view instead of a tile.
	// 0.20.0 raised chat.ts to 269 for an entry's images as thumbnails (thumbs) that open the lightbox (gui/lightbox.ts, 34, loaded on the first open),
	// and views.ts to 326 for the session's queue under the chat (drawQueued).
	// 0.20.0 raised ask.ts (src) to 127, dialogs.ts to 220, and bridge.ts to 237 for the queue each bridge relays: what it saw typed while its agent works, until a turn takes it.
	// 0.19.0 raised layer.ts to 183: a finished alert shows no Later.
	// 0.19.0 raised views.ts to 313 for the session's todo list (drawTodos): the count and the task in progress, unfolded to every task.
	// 0.18.2 raised views.ts to 300 for the close button in the comms header (a phone has the profile far below) and its channel state as a dot.
	// 0.18.1 raised views.ts to 295 for the session view's two modes, its chat or its pane's terminal, one at a time (setMode, and a terminal an alert asks for).
	// 0.17.3 raised chat.ts to 254 for the motion of a message that just arrived or went out, kept across the redraw its result brings.
	// 0.17.2 raised views.ts to 267 for the location bar: a subagent under its launcher's level, and the middle levels folded into "…" on a phone.
	// 0.17.0 raised views.ts to 259 for the close buttons of a base, its squads, and a unit (a subagent's is its launcher's to close).
	for (const [name, max] of [["router.ts", 80], ["chat.ts", 269], ["markdown.ts", 180], ["views.ts", 326], ["lightbox.ts", 34], ["layer.ts", 183], ["composer.ts", 190], ["ask.ts", 156], ["mirror.ts", 154], ["keypad.ts", 60], ["doc.ts", 108], ["i18n.ts", 50], ["slash.ts", 63]] as const) assert.ok(count(`gui/${name}`) <= max, `gui/${name} has ${count(`gui/${name}`)} lines`);
	// 0.10.0: the page's text comes from Paraglide's messages (gui/messages), which raised chat.ts, views.ts, layer.ts, ask.ts, mirror.ts, and doc.ts by one
	// line each for the messages import; the strings replaced in place. gui/i18n.ts picks the locale (the menu's choice, the browser's languages with
	// Chinese by script) and translates index.html's static text: 50 lines, no figure in a spec.
	// 0.8.0 raised views.ts from 245 to 251 for the documents: the dossier's list, a document that arrives opening beside the comms, and the show_doc
	// card's lookup for Open beside. The document tile and its rules (gui/doc.ts, 0.8.0) had the Phase 3 plan's 80; it takes 107, 27 over that figure:
	// beyond the tile, its frame, and revisions it holds the arrival rules (by display name, units that left forgotten), the show_doc path match,
	// the dossier's list, a load of an older revision that finishes late, and a failed load that retries when the tile shows.
	// 0.5.0 raised views.ts from 240 to 245 and layer.ts from 150 to 165 for the read-only question panel (gui/ask.ts) in the session view and
	// in alert dialogs, and layer.ts also for raising a dialog that peeks out beneath the top one.
	// The composer's figure was the spec's 120; 0.5.0 raised it to 125 so a send in flight outlives a composer the route replaced (review R-1);
	// 0.5.1 to 165 for the note a send leaves when no composer is there to say it (a refusal's reason, an edit of text that already went) and the three pure rules around it.
	// 0.5.1 raised layer.ts from 165 to 175: dialogs of units that left the net, one queue count in the header and every dialog, a click that really hit a control;
	// 0.7.0 to 180 for the terminal tiles: a tile's own header icon, a tile that hears it closed (by its × or pushed out), and the mirrors mounted with the layer.
	// The terminal tile (gui/mirror.ts, 0.7.0) has the Phase 3 plan's 130 plus 10: a hidden tab parks its mirrors and a stale check runs only while a tile shows;
	// plus 5 for the key pad's hook (task 4: the pad's type, and its update when the mirror goes live, hidden, stale, or ends). The pad (gui/keypad.ts) has the plan's 60.
	// The answer panel's figure was 130; 0.6.0 raised it to 140 for a panel that belongs to its dialog, so the net's updates leave what the user picked, typed, and noted;
	// 0.7.0 to 155 for Show terminal on a read-only panel (not a secret's).
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
	// 0.7.0 to 190 for a demo terminal: a pane whose screen changes every second while a terminal tile shows it, and the stream's hello.
	assert.ok(demo <= 190, `the demo fixture has ${demo} lines`);
	// 0.13.0 raised views.ts to 253 for the base view's two opening buttons; the opening tile (gui/spawn.ts) has its own figure below.
	// 0.15.0 raised composer.ts to 190 for files: pasted, dropped, or picked, each uploaded and its path put in the message.
	// 0.15.0 to 254 for the squads' + Member buttons, and gui/spawn.ts to 68 for the new base, member, and squad member tiles and the button reader.
	assert.ok(count("gui/spawn.ts") <= 68, `gui/spawn.ts has ${count("gui/spawn.ts")} lines`);
	// The phone pairing tile and the write helper it shares with the composer (0.5.0, no figure in the spec).
	const pairing = sum("gui", ["pair.ts", "post.ts"]);
	// 0.15.0 to 55 for post.ts sending a file's bytes to a session's upload.
	assert.ok(pairing <= 55, `the pairing tile has ${pairing} lines`);
	const shipped = new Set(["router.ts", "chat.ts", "lightbox.ts", "follow.ts", "markdown.ts", "views.ts", "layer.ts", "alerts.ts", "overlay.ts", "fixture.ts", "demo-chat.ts", "composer.ts", "pair.ts", "spawn.ts", "post.ts", "ask.ts", "mirror.ts", "keypad.ts", "doc.ts", "i18n.ts", "slash.ts"]);
	const page = sum("gui", names("gui").filter((name) => !shipped.has(name)));
	// 0.8.0 raised it from 540 to 543 for the scroll badge with the count of a unit's documents on its plate (render.ts).
	// 0.10.0 to 554 for the messages: the import in main.ts, render.ts, log.ts, and stream.ts, the locale started in main.ts, and render.ts's role
	// names and the server's fixed status words as messages (a note it does not know shows as it is).
	// 0.11.0 to 558 for main.ts reloading a page whose stream says hello from another build than the one the server wrote into it.
	// 0.15.0 to 578 for the opening buttons on the map: render.ts points a base's and each squad's at + Main or + Member, main.ts opens their tile.
	// 0.17.0 to 598 for the close buttons: render.ts aims a base's and each squad's (aimClose), main.ts confirms and posts every close.
	// 0.18.1 to 612 for the page's own confirm dialog (main.ts) and the terminal an alert opens in its session view.
	// 0.18.2 to 623 for the tab icon's badge (main.ts).
	// 0.20.0 to 631 for main.ts: a closed base or unit's view goes up to what is left (leave), Escape left to an open modal, and each entry's image URL.
	assert.ok(page <= 631, `the page's TypeScript has ${page} lines`);
});

test("the built page is small, self-contained (no remote URLs, fonts, or imports), and carries no demo fixture", { skip: !existsSync(join(root, "dist/gui/index.html")) && "run npm run gui:build first" }, () => {
	const dir = join(root, "dist/gui");
	const files = [join(dir, "index.html"), ...readdirSync(join(dir, "assets")).filter((name) => !name.endsWith(".woff2")).map((name) => join(dir, "assets", name))];
	// The one font: the Nerd Font symbols a pane's screen may show (about 1.1 MB), served by the page's own server and fetched only for such a glyph.
	const fonts = readdirSync(join(dir, "assets")).filter((name) => name.endsWith(".woff2"));
	assert.ok(fonts.length === 1 && fonts[0]!.startsWith("SymbolsNerdFontMono-") && statSync(join(dir, "assets", fonts[0]!)).size <= 1_200_000, `fonts: ${fonts.join(", ")}`);
	const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
	// Paraglide's runtime names two placeholder origins in its URL helpers and its docs in an error message; the page fetches none of them.
	const named = ["http://www.w3.org/2000/svg", "http://example.com", "http://fallback.com", "https://paraglidejs.com/errors#no-locale-found"];
	const remote = [...text.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]).filter((url) => !named.includes(url));
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
	// 0.7.0 raised the gzip figure from 6 KB to 6.1 KB: the page's one stream lives in this chunk, so it routes the terminal tiles' hello and frames to the layer.
	// 0.10.0 to 24.7 KB / 9.75 KB for English and Traditional Chinese (Paraglide): its runtime, about 5 KB raw, whose locale getter stays whole because
	// every message calls it, and the header's, map's, log's, and banner's messages, each a function per locale with both languages' strings.
	// 0.11.0 to 24.75 KB / 9.78 KB for the reload of a page whose server now runs another build (a newer pi-straw-boss took it over).
	// 0.15.0 to 25.65 KB / 10 KB for the map's opening buttons (+ New base, a base's and a squad's + Main or + Member) and their click handler.
	// 0.17.0 raised the map chunk to 27.7 KB / 10.7 KB for the close buttons on bases and squads and the confirmation before each close.
	// 0.18.1 to 28.4 KB / 10.9 KB for the page's own confirm dialog, which a browser confirm() gave way to.
	// 0.18.2 to 29 KB / 11.2 KB for the tab icon's badge, the count of units waiting on an answer.
	// 0.20.0 to 29.55 KB / 11.35 KB for leaving a closed base or unit's view, and Escape left to an open modal.
	assert.ok(size(entry).length <= 29_550 && gz(entry) <= 11_350, `the map chunk is ${size(entry).length} bytes (${gz(entry)} gzipped)`);
	// The lazy chunks' gzip figure was 12 KB; 0.5.0 raised it to 14 KB for the composer (about 2.2 KB gzipped) and the phone pairing tile with its POST helper (about 1.1 KB).
	// The question panel (0.5.0, read-only, about 0.7 KB gzipped) and its place in the dialogs and the session view raised the gzip figure to 15.5 KB;
	// 0.5.1 to 36.5 KB / 16.2 KB for the composer's note and the dialogs of units that left the net (about 0.7 KB gzipped together).
	// 0.6.0 to 40 KB / 17.5 KB for the answer panel (gui/ask.ts: a select with notes and Copy command, questionnaires with own words and notes, outcomes and Check again; about 1.2 KB gzipped),
	// and to 40.5 KB raw for a panel that belongs to its dialog across the net's updates (about 0.5 KB, 0.1 KB gzipped).
	// 0.6.1 to 40.9 KB / 17.8 KB for the panel's busy, linger, and focus fixes and the tool card's "show all arguments" (about 0.35 KB, 0.26 KB gzipped).
	// 0.7.0 to 46.5 KB / 20.3 KB for the terminal tile (gui/mirror.ts: the SGR renderer, frames, fit width, parking, about 2.3 KB gzipped with its place in the layer and the dossier).
	// And to 48.5 KB / 21 KB for the key pad (gui/keypad.ts: 23 keys in rows, the digits folded, the server's confirm inline; about 0.6 KB gzipped).
	// 0.8.0 to 52 KB / 22.5 KB for the document tiles (gui/doc.ts: the sandboxed frame, text and markdown, revisions, arrivals, the dossier list; about
	// 3.8 KB, 1.45 KB gzipped with Open beside and the dossier). The Phase 3 plan proposed 50 KB / 21.5 KB for the terminal tile, key pad, and document
	// tile together, estimating the document tile at about 1 KB gzipped: this is 2 KB raw and 1 KB gzipped over that proposal.
	// 0.10.0 to 67.1 KB / 28.05 KB for the messages of the focus views, comms, dialogs, and tiles in both languages (Paraglide, as in the map chunk).
	// 0.12.0 to 67.85 KB / 28.35 KB for the pairing tile asking to turn remote access on, in both languages.
	// 0.13.0 to 71.6 KB / 30.2 KB: the opening tile (a folder picker and two forms, its own chunk loaded on click) and the base view's two buttons, in both languages.
	// 0.14.0 to 72.6 KB / 30.6 KB for the composer's `/` menu (gui/slash.ts) and the follow-up button's hint, in both languages.
	// 0.15.0 to 74.3 KB / 31.1 KB for the new base, member, and squad member tiles, and the composer's file paste, drop, and picker, in both languages.
	// 0.17.0 to 74.9 KB / 31.3 KB for the close button in a unit's view and the close confirmations in both languages.
	// 0.17.2 to 75.1 KB / 31.3 KB for the launcher levels in the location bar; 0.17.3 to 75.3 KB / 31.35 KB for the motion of new messages.
	// 0.18.1 to 76.4 KB / 31.7 KB for the session view's chat and terminal modes.
	// 0.18.2 to 76.9 KB / 31.8 KB for the comms header's close button.
	// 0.19.0 to 77.7 KB / 32.1 KB for the session's todo list above the composer and the finished alert that needs no Later.
	// 0.20.0 to 80.45 KB / 33.3 KB for thumbnails and their lightbox (its own chunk), the queue under the chat, and the queued labels.
	assert.ok(chunks.length >= 1 && total(chunks, (n) => size(n).length) <= 80_450 && total(chunks, gz) <= 33_300, `the chat chunks are ${total(chunks, (n) => size(n).length)} bytes (${total(chunks, gz)} gzipped)`);
	// The stylesheet's figure was 22 KB / 6 KB; 0.4.0 raised it by 0.1 KB for the comms anchor highlight, the receive-only strip, and the title link;
	// 0.5.0 to 24.6 KB / 6.7 KB for the composer, the phone layout with its touch targets and safe-area insets, and the pairing tile.
	// and to 26 KB / 7 KB for the read-only question panel and the net log that folds on a phone; 0.5.1 to 26.5 KB raw for the queue line in the dialogs.
	// 0.6.0 to 27.5 KB / 7.25 KB for the answer panel's toggles, fields, and Send.
	// 0.7.0 to 29 KB / 7.7 KB for the terminal tile: its 16 colours as text and background classes, the attributes, the bar, and the scroll box.
	// And to 30.5 KB / 8 KB for the key pad: its key caps and rows, 44 px targets on a phone, the digits' fold, and the confirm.
	// 0.8.0 to 32 KB / 8.25 KB for the documents: the parchment badge on a plate, the dossier's list, and the tile's bar, frame, and text (about 1.5 KB,
	// 0.3 KB gzipped). The Phase 3 plan proposed 31 KB / 8.25 KB: this is 1 KB raw over it, within its gzip figure.
	// 0.13.0 to 32.7 KB / 8.375 KB for the opening tile: the base view's button row, the folder path and grid, the form fields, and the open button's colour (about 0.7 KB, 0.1 KB gzipped).
	// 0.14.0 to 33.3 KB / 8.475 KB for the `/` menu above the composer: its box, rows, the lit row, and the name and description (about 0.6 KB, 0.1 KB gzipped).
	// 0.15.0 to 34.05 KB / 8.625 KB for the opening buttons: a squad's small + Member, the base card's row, and the dashed + New base card, and short form tiles keeping their own height (about 0.7 KB, 0.15 KB gzipped).
	// 0.17.0 to 34.25 KB / 8.67 KB for the close buttons; 0.17.2 to 34.9 KB / 8.85 KB for runs of chat messages that show their avatar once and the folding location bar; 0.17.3 to 35.2 KB / 8.9 KB for the motion of new messages;
	// 0.18.0 to 35.5 KB / 9.1 KB for the Nerd Font symbols face of a pane's screen; 0.18.1 to 36.6 KB / 9.3 KB for the confirm dialog and the modes;
	// 0.18.2 to 37.2 KB / 9.45 KB for the comms header's two rows on a phone and its one-line name; 0.19.0 to 38.25 KB / 9.65 KB for the todo list;
	// 0.20.0 to 40 KB / 10.05 KB for thumbnails, the lightbox, the queue under the chat, and a squad name kept to one line.
	assert.ok(total(css, (n) => size(n).length) <= 40_000 && total(css, gz) <= 10_050, `the stylesheet is ${total(css, (n) => size(n).length)} bytes (${total(css, gz)} gzipped)`);
});
