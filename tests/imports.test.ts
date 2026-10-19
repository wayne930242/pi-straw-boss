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
	// 0.27.0 to 275: what a tick re-reads for every child is cached (the pane that runs each child, indexed once per pane list; the two directories pi-herdr-agents keeps; a launch script's session file),
	// and the screen reads on Herdr's events (watch, debounced) with a 30 s safety poll, and reads again what was requested inside the minimum gap or while a read ran, instead of dropping it.
	// 0.27.0 to 277: the gap is checked again when a pending read fires, and a listing remembers when it was read.
	assert.ok(count("src/dashboard.ts") <= 277, `src/dashboard.ts has ${count("src/dashboard.ts")} lines`);
	// 0.5.0 raised the server's figure from 300 to 320 for the CSRF meta, the POST routing into control.ts, and the remote access check (pairing, remote streams);
	// 0.6.0 to 325 for the hub's start and stop with the server, the answer route's fresh reading, gui.json's ownerSession, and the sessions a reading binds dialogs with;
	// 0.7.0 to 330 for the terminal mirror (Phase 3 task 1): each stream's `hello` with its id, and the mirrors it holds created, closed with it, and stopped with the server.
	// 0.8.0 to the Phase 3 plan's 335 for documents: a unit's documents in the snapshot (task 6), the document routes' dispatch and the app's frame-src (task 7).
	// 0.10.1 to 336 for the bundle read whole at start, so a package update under a running server leaves its page's assets in place.
	// 0.11.0 to 377 for any session reaching the one server: the stop request and its wait (requestStop), the takeover in sharedGui, the version
	// and reload mark gui.json keeps (newer, markReload), the server's own stop for onStop, and the build named in the page and each hello.
	// 0.18.0 to 379 for the font: its type, and a cache that keeps it (its name carries its hash).
	// 0.20.0 to 386 for a unit's queue (Queued) and the image route, with its cache for entries that never change.
	// 0.24.0 to 387 for a subagent's `ended` on its unit, so the page clears its finished alert.
	// 0.25.0 to 388 for a unit's background monitors (the Monitor type on Unit and on the tower).
	// 0.27.0 to 299: the one-server-per-machine record and handover (gui.json, requestStop, sharedGui) came out into handover.ts, which has its own figure.
	// Remote listener: a second loopback server with its own handler, port, and close, so a request is remote by the listener it arrived on: 299 to 320.
	assert.ok(sum("src", ["net.ts", "gui.ts"]) <= 320, `src/net.ts and src/gui.ts have ${sum("src", ["net.ts", "gui.ts"])} lines`);
	// Input (the spec's figure), remote access over Tailscale, its terminal pairing panel (QR, c copies, o opens), and the QR encoder each have their own.
	// What a waiting session waits on (0.5.0, read for display only; answering is deferred) has its own as well.
	// 0.5.1 raised remote.ts from 165 to 185 (a recorded server counts as running only if its process started when the entry says: a reused PID
	// is not the owner) and ask.ts from 80 to 115 (the current branch's path instead of a line scan, a window that grows for a long call, and ask_user_question's list of questions).
	// The remote listener raised remote.ts from 185 to 192: the listener a request arrived on decides local or remote, and the old local-port entry is repointed.
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
	// 0.27.0 index.ts, the one closure that held every concern, is the composition root (51 lines at most in "the rest") and its concerns have a module and a figure each,
	// none in a spec: state.ts (what the modules share: the configuration, the one mutable State, the Kit they are built from), briefing.ts (the role prompt and its steer),
	// reach.ts (a message, a broadcast, status, and the tower of a workspace), election.ts (pin and claim: who is the tab's main), guard.ts (the tower and the mains go together),
	// presence.ts (the tokens a session publishes), membership.ts (the tab channel, its events, the join, and promotion), tools.ts (the agent's boss_* tools), tower.ts (the tower's start),
	// closing.ts (/boss close and the pane that closes after pi exits), host.ts (the GUI server this session hosts and its /boss gui commands), boss.ts (the /boss command),
	// and session.ts (the hooks at the session's start, around each run, and its end).
	// 0.27.0 towertab.ts (65 at most) holds what herdr.ts held for the tower's tab: finding a live tower or opening one, one opening at a time per workspace.
	// 0.27.0 handover.ts (93 at most) holds what gui.ts held for sharing one server between sessions: gui.json's record, the stop request, the takeover.
	// 0.15.0 raised control.ts to 176 for sessions/<key>/upload, a file's bytes under the same origin and CSRF checks, handed to upload.ts (50 at most).
	// 0.15.0 raised spawn.ts from 123 to 168: a base opens with a member and no tower, a base without a tower takes members (split into a squad or in
	// a new tab), only one with a tower takes mains, and every opening shares the start, join wait, first message, and close-on-failure.
	// 0.17.2 raised server-watch.ts to 110 for herdrEvents, the event stream the tower guard listens to.
	// 0.17.0 raised bridge.ts to 206 for `close`, the session asked to quit as /boss close does, and its answer.
	// 0.17.0 raised dialogs.ts to 217 for the hub's side of `close`: the request, its answer, and its drop when the server stops.
	// 0.17.0 raised control.ts to 178 for close/unit, close/tab, close/base, handed to closer.ts (70 at most).
	// 0.24.0 raised keys.ts from 80 to 103 for a desktop's keyboard under the pad's guards: typed text (one write of 1 to 64 printable characters),
	// a paste inside the bracketed-paste markers, Delete, and Ctrl or Alt chords, with Ctrl+Z refused and Ctrl+D and a second Ctrl+C confirmed.
	// 0.25.0 raised ask.ts to 130, bridge.ts to 242, and dialogs.ts to 223 to relay a session's background monitors with its dialogs, checked by
	// the hub and set on its unit; monitors.ts (75 at most) follows them from pi-loop-monitor's events.
	// 0.27.0 raised tower.ts from 42 to 44 (the dashboard subscribes to Herdr's events) and state.ts from 105 to 106 (the `world` dependency).
	// 0.28.0 raised order.ts from 81 to 97 (`unplaced`, whether a launched subagent still has no pi pane) and presence.ts from 57 to 93 (the subscription to Herdr's events that marks such a subagent when its pi is detected, and the reading it triggers).
	// 0.28.0 raised ask.ts from 130 to 135: a file's open calls (OpenCall) go to merge with its pending, so a dialog can bind to one of several; dialogs.ts from 223 to 228 for the binding itself and the secret_drop check among several calls.
	// 0.28.0 raised owners.ts from 120 to 139 (the secret_drop owner: its pending shape and digest, one contract adapter parameterised by shape), dialogs.ts from 228 to 237 (the secret binding, its answer check, and its remote refusal),
	// ask.ts from 135 to 144 (forRemote: the net a paired device sees), and control.ts from 178 to 179 (a value never comes from a remote page).
	// The secret's end-to-end seal (seal.ts, 56, the envelope on its own) raised bridge.ts from 242 to 250 (a key pair per secret dialog, relayed with it, dropped when it closes; a sealed
	// answer opened before the owner hears it, a plain one refused) and dialogs.ts from 237 to 271 (each secret dialog's key pinned at first sight so a changed or missing one leaves it
	// in the terminal, and the value sealed to it as it leaves).
	// Secret entry left the GUI (SB-F001): ask.ts is back to 136 (no forRemote), bridge.ts to 246 (no key pair; a secret dialog is not relayed), and dialogs.ts to 237 (no key pinning, no sealing).
	// Unreleased: intercept.ts (143, new: the wrap of ctx.ui.select and confirm, a dialog contract owner under straw-boss:ui) has its own figure. owners.ts 139 to 145 for that owner
	// (`twin`, a confirm's flag in the select and its digest), bridge.ts 246 to 250 for the rule that a twin yields to a contract owner's dialog on the same tool call,
	// and control.ts 179 to 180 for the refusal of a confirm from a paired device.
	for (const [name, max] of [["commands.ts", 32], ["control.ts", 180], ["closer.ts", 70], ["upload.ts", 50], ["spawn.ts", 168], ["remote.ts", 192], ["pairing.ts", 60], ["qr.ts", 140], ["ask.ts", 136], ["bridge.ts", 250], ["owners.ts", 145], ["dialogs.ts", 237], ["seal.ts", 56], ["monitors.ts", 75], ["order.ts", 97], ["mirror.ts", 135], ["probe.ts", 40], ["keys.ts", 103], ["documents.ts", 80], ["docs.ts", 150], ["orphan.ts", 115], ["opener.ts", 90], ["server-watch.ts", 110], ["handover.ts", 93], ["towertab.ts", 65], ["state.ts", 106], ["briefing.ts", 33], ["reach.ts", 96], ["election.ts", 24], ["guard.ts", 83], ["presence.ts", 93], ["membership.ts", 115], ["tools.ts", 77], ["tower.ts", 44], ["closing.ts", 23], ["host.ts", 82], ["boss.ts", 36], ["session.ts", 133], ["intercept.ts", 175]] as const) assert.ok(count(`src/${name}`) <= max, `src/${name} has ${count(`src/${name}`)} lines`);
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
	const apart = ["commands.ts", "dashboard.ts", "net.ts", "gui.ts", "history.ts", "items.ts", "watch.ts", "balance.ts", "control.ts", "remote.ts", "pairing.ts", "qr.ts", "ask.ts", "blocked.ts", "bridge.ts", "owners.ts", "dialogs.ts", "seal.ts", "monitors.ts", "order.ts", "mirror.ts", "probe.ts", "keys.ts", "documents.ts", "docs.ts", "orphan.ts", "opener.ts", "spawn.ts", "upload.ts", "closer.ts", "server-watch.ts", "handover.ts", "towertab.ts", "state.ts", "briefing.ts", "reach.ts", "election.ts", "guard.ts", "presence.ts", "membership.ts", "tools.ts", "tower.ts", "closing.ts", "host.ts", "boss.ts", "session.ts", "intercept.ts"];
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
	// 0.21.0 to 905: boss_rename (index.ts, 11 lines), and a role that changes during a run reaching the agent as a steer (rebrief, 9 lines).
	// 0.27.0 to 193: index.ts (51) is the composition root and herdr.ts (142) the Herdr client; everything else the closure held has a module and a figure above.
	// 0.27.0 to 234: index.ts (53, the listings over the socket unless a run is injected) and herdr.ts (181: socketReads, the listings' socket requests, and the world as one session.snapshot or as listings asked together).
	// 0.28.0 to 235: index.ts (54), the delay before a subagent's pane is read once Herdr reports a pi (`detectMs`).
	// Unreleased to 237: index.ts (56), the wrap of ctx.ui installed beside the bridge (its import and one call).
	assert.ok(rest <= 237, `the rest of src has ${rest} lines`);
	// The page: the files the spec budgets one by one, then this round's own figures (no figure in the spec): the focus views, the overlay
	// layer (alert spotting and the stack model in the map's chunk, the layer's DOM and tiles in a chunk of their own), the dev-only demo, and everything else.
	// 0.18.1 raised mirror.ts to 154 for embed, a terminal shown inside the session view instead of a tile.
	// 0.20.0 raised chat.ts to 269 for an entry's images as thumbnails (thumbs) that open the lightbox (gui/lightbox.ts, 34, loaded on the first open),
	// and views.ts to 326 for the session's queue under the chat (drawQueued).
	// 0.20.0 raised ask.ts (src) to 127, dialogs.ts to 220, and bridge.ts to 237 for the queue each bridge relays: what it saw typed while its agent works, until a turn takes it.
	// 0.19.0 raised layer.ts to 183: a finished alert shows no Later.
	// 0.23.0 to 212 for the finished list: the HUD's Finished button and its popover (a row per finished unit that opens its comms and clears it, and Clear all), apart from the HUD alert.
	// 0.24.0 to 232 for a dialog's Enlarge (the wide dock, kept per browser); mirror.ts from 154 to 175 for a desktop's keyboard into the focused
	// terminal (the hidden text box and its key, input, composition, and paste listeners, the note, the glow) and Fit width going to the bottom;
	// keypad.ts from 60 to 124 for that keyboard's key and chord map, typed text and pastes, and its write queue (one write at a time, 130 ms
	// apart, typed characters joined, a refusal or a confirm dropping the rest).
	// 0.19.0 raised views.ts to 313 for the session's todo list (drawTodos): the count and the task in progress, unfolded to every task.
	// 0.18.2 raised views.ts to 300 for the close button in the comms header (a phone has the profile far below) and its channel state as a dot.
	// 0.18.1 raised views.ts to 295 for the session view's two modes, its chat or its pane's terminal, one at a time (setMode, and a terminal an alert asks for).
	// 0.17.3 raised chat.ts to 254 for the motion of a message that just arrived or went out, kept across the redraw its result brings.
	// 0.17.2 raised views.ts to 267 for the location bar: a subagent under its launcher's level, and the middle levels folded into "…" on a phone.
	// 0.17.0 raised views.ts to 259 for the close buttons of a base, its squads, and a unit (a subagent's is its launcher's to close).
	// 0.25.0 raised views.ts to 347 for the monitors bar under the todos (each monitor's state, exit code, line count, and last line), chat.ts to 270 for its type on a unit.
	// 0.26.1 raised chat.ts to 274 to leave a log where the finger holds it, and while its fling coasts, instead of pulling it to the bottom.
	// 0.27.0 raised chat.ts to 275: the log's end and top are read off two sentinels that watch only while it scrolls (no geometry is read per scroll event), and the lit entry restarts without a layout read.
	// 0.25.1 raised views.ts to 348 for a phone's comms scrolled into view as the session opens, so its composer is on screen.
	// 0.27.0 split views.ts (348) into its coordinator (90) and the modules it calls: the Scene they read (scene.ts), the unit token (tokens.ts), the location bar and
	// the entrance (nav.ts), the workspace route (workspace.ts), the dossier (dossier.ts), the session's comms (session.ts), and the bars above its composer (bars.ts).
	for (const [name, max] of [["router.ts", 80], ["chat.ts", 275], ["markdown.ts", 180], ["views.ts", 90], ["scene.ts", 32], ["tokens.ts", 23], ["nav.ts", 43], ["workspace.ts", 59], ["dossier.ts", 49], ["session.ts", 115], ["bars.ts", 50], ["lightbox.ts", 34], ["layer.ts", 249], ["askkeys.ts", 75], ["composer.ts", 190], ["ask.ts", 185], ["mirror.ts", 175], ["keypad.ts", 124], ["doc.ts", 108], ["i18n.ts", 50], ["slash.ts", 63]] as const) assert.ok(count(`gui/${name}`) <= max, `gui/${name} has ${count(`gui/${name}`)} lines`);
	// 0.28.0 to 185 with the answer keys' hooks into gui/ask.ts (the focus on the first option, the textarea). 0.28.0 raised gui/ask.ts from 156 to 175 for the secret panel: the masked field with Show and Hide, Submit, the way back to the terminal, the unsupported-remote notice, and a value that leaves with its one request.
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
	// 0.23.0 to 136 for finished units in a list of their own (the HUD alert opens questions and errors only, resolve clears one or all) and a
	// finished alert that clears itself once its unit's pane closed. 0.24.0 to 139: also once pi-herdr-agents recorded the subagent's run done.
	// 0.25.0 to 148 for an alert of a failed or quiet monitor: its own key, `unit` (and unitOf) for the unit it belongs to, and its note.
	assert.ok(overlay <= 148, `the overlay model has ${overlay} lines`);
	const demo = sum("gui", ["fixture.ts", "demo-chat.ts"]);
	// 0.5.0 raised it from 160 to 165 for a demo question and a demo secret; 0.6.0 to 170 for a demo robot_hand selector and questionnaire that answer;
	// 0.6.1 to 174 for a demo tool call whose arguments show cut (with the whole of them for "show all arguments"), an answerable dialog that stays
	// until it is answered, and a toolbar that folds to a tab in the margin on a phone.
	// 0.7.0 to 190 for a demo terminal: a pane whose screen changes every second while a terminal tile shows it, and the stream's hello.
	// 0.28.0 to 191 for a demo secret that answers (n % 4 == 1) beside the one that only waits in the terminal.
	assert.ok(demo <= 191, `the demo fixture has ${demo} lines`);
	// 0.13.0 raised views.ts to 253 for the base view's two opening buttons; the opening tile (gui/spawn.ts) has its own figure below.
	// 0.15.0 raised composer.ts to 190 for files: pasted, dropped, or picked, each uploaded and its path put in the message.
	// 0.15.0 to 254 for the squads' + Member buttons, and gui/spawn.ts to 68 for the new base, member, and squad member tiles and the button reader.
	assert.ok(count("gui/spawn.ts") <= 68, `gui/spawn.ts has ${count("gui/spawn.ts")} lines`);
	// The phone pairing tile and the write helper it shares with the composer (0.5.0, no figure in the spec).
	const pairing = sum("gui", ["pair.ts", "post.ts"]);
	// 0.15.0 to 55 for post.ts sending a file's bytes to a session's upload.
	assert.ok(pairing <= 55, `the pairing tile has ${pairing} lines`);
	// Unreleased: the answer form's keys (gui/askkeys.ts: arrows, Tab, Enter, and Space between options, questions, own words, and Send, one tab stop per group) have a figure of their own,
	// and layer.ts went to 249 for the dialog that takes the focus on its first option instead of Open comms (4 lines).
	// Unreleased: the dialogs' keys (Space opens the next alert, F enlarges the top dialog; gui/hotkeys.ts: the routing and its listeners) have a figure of their own,
	// and layer.ts went to 245 for the hotkey entry both keys reach (13 lines); hotkeys.ts went to 50 for the pointer-focus tracking that lets Space through on a control the mouse left focused.
	assert.ok(count("gui/hotkeys.ts") <= 50, `gui/hotkeys.ts has ${count("gui/hotkeys.ts")} lines`);
	const shipped = new Set(["router.ts", "chat.ts", "lightbox.ts", "follow.ts", "markdown.ts", "views.ts", "scene.ts", "tokens.ts", "nav.ts", "workspace.ts", "dossier.ts", "session.ts", "bars.ts", "layer.ts", "alerts.ts", "overlay.ts", "fixture.ts", "demo-chat.ts", "composer.ts", "pair.ts", "spawn.ts", "post.ts", "ask.ts", "mirror.ts", "keypad.ts", "doc.ts", "i18n.ts", "slash.ts", "hotkeys.ts", "askkeys.ts"]);
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
	// 0.21.0 to 718 for reminders and sounds: notify.ts (87 lines, the header's switches, notifications, one sound a batch) and main.ts handing it each snapshot's arrivals.
	// 0.23.0 to 748 for the sound panel (notify.ts: on, volume through Web Audio's gain, a try) and the popover placement it shares (render.ts).
	// 0.24.0 to 752 for the demo build (vite.config.ts: GUI_DEMO, the base it is served under, and its own output folder).
	// 0.25.0 to 754 for a failed monitor's note in words (render.ts).
	// 0.25.1 to 755 for main.ts hiding Phone on a paired device's page (pairing is this computer's to start).
	// 0.26.0 to 760 for Quit on each unit of the map (render.ts: its key, name, role, and whether this unit may quit).
	// 0.26.1 to 763 for Quit tower on the map (render.ts: the tower's key and name, shown when it may quit).
	// 0.27.0 to 779 for Quit in one module (quit.ts: the four buttons' labels and data, the confirmation, and the close's aftermath, out of render.ts and main.ts): its header, imports, and exports.
	// 0.27.0 to 827 for the page's idle motion: calm.ts (26: infinite animations rest after 30 s without input), packets.ts (23: the wires' packets as compositor keyframes
	// instead of SVG animateMotion), and `replay` in dom.ts (3: a one-shot animation restarted without a layout read), less what they replaced in render.ts, main.ts, nav.ts, chat.ts, and mirror.ts.
	// 0.27.0 to 831: packets.ts interpolates between curve samples so a packet's pace is even.
		// Unreleased to 833: main.ts mounts the dialogs' keys (hotkeys.ts) and takes the modal selector from it.
	assert.ok(page <= 833, `the page's TypeScript has ${page} lines`);
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
	// 0.21.0 to 32.65 KB / 12.5 KB for reminders and sounds (notify.ts): the header's two switches, system notifications, and the sounds' URLs
	// (the clips themselves stay files), with their messages in both languages.
	// 0.23.0 to 33.85 KB / 13 KB for the sound panel (on, a volume played through Web Audio's gain, and a try), the popover placement it shares
	// with the finished list, and a finished alert that clears itself once its pane closed.
	// 0.25.0 to 34.55 KB / 13.25 KB for a failed or quiet monitor's alert (its own key, the unit it belongs to, and its note), with the
	// monitors bar's messages in both languages.
	// 0.26.0 to 35.05 KB / 13.4 KB for Quit on the map: each unit's, and the base's and squad's as words instead of ×, in both languages.
	// 0.26.1 to 35.4 KB / 13.45 KB for Quit tower on the map, in both languages.
	// 0.27.0 to 35.4 KB / 13.5 KB for the one Quit module: the four named aim functions and the confirmation moved out of the other files cost a few dozen bytes more than the inline code.
	// 0.27.0 to 36.9 KB / 14.05 KB for the map's packets as keyframes along each wire (packets.ts) instead of SVG animateMotion, the page's rest after 30 s without input (calm.ts), and replay (dom.ts).
	// 0.27.0 to 37 KB / 14.15 KB gzipped: the packets' even spacing (interpolated keyframe points).
	// Unreleased to 37.8 KB / 14.4 KB gzipped for the dialogs' keys (hotkeys.ts: the routing, its listeners, and the hint in each tooltip in both languages).
	// Unreleased to 38 KB / 14.5 KB gzipped for Space on a control the mouse left focused (hotkeys.ts: its pointer and focus listeners and the answer-option exception).
	assert.ok(size(entry).length <= 38_000 && gz(entry) <= 14_500, `the map chunk is ${size(entry).length} bytes (${gz(entry)} gzipped)`);
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
	// 0.23.0 to 81.85 KB / 33.8 KB for the finished list in the overlay layer: the HUD's Finished button, its rows, and Clear all.
	// 0.24.0 to 86.05 KB / 35.4 KB for a dialog's Enlarge, and a desktop's keyboard straight into a focused terminal (keypad.ts and mirror.ts in the
	// overlay layer: the key and chord map, the hidden text box for characters, input methods, and pastes, the paced write queue, and the note and glow).
	// 0.25.0 to 88 KB / 35.9 KB for the monitors bar in the comms view, and the terminal taking the keyboard as the view switches to it.
	// 0.25.1 to 88.1 KB for a phone's comms scrolled into view as the session opens.
	// 0.26.1 to 88.6 KB / 36.05 KB for a phone's Info and its full-screen dossier with a tower's squads, and a log held while a finger drags it.
	// 0.27.0 to 89.55 KB / 36.425 KB: views.ts split into eight modules costs about 0.9 KB raw (0.4 KB gzipped) in the same chunk, for the parameters that carry the
	// Scene and the `scene.` property reads that do not minify.
	// 0.27.0 to 89.6 KB / 36.5 KB (+0.08 KB / +0.08 KB gzipped) for markdown.ts handing a nested body down as lines with the indents measured once, which is what takes the 3,000-line staircase from 210 ms to 15 ms.
	// Unreleased to 89.7 KB: layer.ts's hotkey entry for Space and F, and the tooltips' key hints in both languages.
	// Unreleased to 92.1 KB / 37.5 KB for the answer form's keyboard (gui/askkeys.ts, about 2.3 KB raw and 1.0 KB gzipped) and the focus on a dialog's first option.
	// 0.28.0, with the answer keys, to 94.6 KB / 38.4 KB: the secret panel (+2.3 KB / +0.8 KB gzipped) (gui/ask.ts) and its nine messages in both languages.
	assert.ok(chunks.length >= 1 && total(chunks, (n) => size(n).length) <= 94_600 && total(chunks, gz) <= 38_400, `the chat chunks are ${total(chunks, (n) => size(n).length)} bytes (${total(chunks, gz)} gzipped)`);
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
	// 0.21.0 to 40.6 KB / 10.2 KB for the reminder and sound switches (their dot per state) and a phone's header in three rows.
	// 0.23.0 to 42.1 KB / 10.5 KB for the header's popovers (the sound panel and the finished list with its rows) and the Finished button beside the HUD alert, kept on one line on a 320 px phone.
	// 0.24.0 to 43.6 KB / 10.85 KB for a dialog's Enlarge (the wide dock in the middle of the window), a header that tightens and wraps between a
	// phone and a wide screen, and a terminal that takes the keyboard: its ring, lit edge, flash per key, pulsing note, and the hidden text box.
	// 0.25.0 to 45 KB / 11.1 KB for the monitors bar: its summary, and each monitor's mark, state, and last line.
	// 0.25.1 to 45.1 KB / 11.12 KB for a phone's composer (no blank note line under Send, + on Send's row) and Open comms centred in its touch box.
	// 0.26.0 to 45.7 KB / 11.2 KB for a phone's full-screen session (fixed comms and tiles over the visual viewport, the back button) and Quit on the map.
	// 0.26.1 to 46.35 KB / 11.3 KB for Quit tower, a phone's Info and full-screen dossier, and a tower's squads in its dossier.
	// 0.26.2 to 11.35 KB gzipped: a phone hides only a dialog's Enlarge, not the base map that shares its .zoom class.
	// 0.27.0 to 47.5 KB / 11.56 KB for the page's idle motion: the packets' dots, the still signs a calm page shows in place of each endless animation, the second name of each restartable keyframe set (`-b`, so a one-shot animation replays without a layout read), and per-kind stand-in heights for the log's entries.
	// 0.27.0 to 47.6 KB / 11.6 KB gzipped: the desktop composer keeps its column when a long URL is typed.
	// Unreleased to 47.65 KB: the own-words box is a textarea that grows with its lines (Shift+Enter breaks one).
	// 0.28.0, with the textarea, to 48.1 KB / 11.7 KB for the secret panel's steps, destination, and masked field.
	// The secret's masked field is a text input drawn as dots by CSS (never type=password), to 48.2 KB.
	assert.ok(total(css, (n) => size(n).length) <= 48_200 && total(css, gz) <= 11_700, `the stylesheet is ${total(css, (n) => size(n).length)} bytes (${total(css, gz)} gzipped)`);
});
