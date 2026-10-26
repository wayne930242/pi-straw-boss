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
	for (const name of readdirSync(join(root, "src/agent")).filter((file) => file.endsWith(".ts"))) {
		for (const [, specifier] of readFileSync(join(root, "src/agent", name), "utf8").matchAll(/from\s+["'](\.\.\/(?:host|gui|dialogs|bridge|handover|mirror|control)\.ts)["']/g)) assert.fail(`src/agent/${name} imports ${specifier}: a net sidecar never hosts or reaches the GUI`);
	}
	for (const dir of ["src", "src/agent"]) {
		for (const name of readdirSync(join(root, dir)).filter((file) => file.endsWith(".ts"))) {
			for (const [, specifier] of readFileSync(join(root, dir, name), "utf8").matchAll(/from\s+["'](\.[^"']*)["']/g)) {
				assert.match(specifier ?? "", /\.ts$/, `${dir}/${name} imports ${specifier}`);
			}
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
	// Unreleased to 286: `commanding`, the mark of a session that is idle while a subagent of it works or waits (or a monitor runs), and the rows built with it.
	assert.ok(count("src/dashboard.ts") <= 286, `src/dashboard.ts has ${count("src/dashboard.ts")} lines`);
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
	// Unreleased to 323: finished subagents a page dismissed stay hidden until they leave the net (net.ts), and gui.ts hands the dismissal to control.
	// Unreleased to 327: a tower's subagents, collected as a member's are (net.ts: the towers' rows, one subagent builder for both).
	// Unreleased to 335: Dismiss finished (net.ts: dismissAll), the streams of one device told apart (gui.ts: remotes by device, the renewed cookie, remote/* shut to a paired device, the options and handlers for off, devices, and dismissAll).
	// Unreleased to 337: the stashed bases in the net (net.ts: the type and the list read with each snapshot).
	// Unreleased (net sidecar) to 338: `Unit.agent`, the agent of a unit that is not a pi session (net.ts).
	// Unreleased (comfort) to 343: net.ts types what a unit did lately (since, ticks, todo) and the net's events, and runs each reading through the activity tracker.
	// 0.42.4 to 351: an installed app's launch arrives from another site without the SameSite=Strict cookie, so a page load from outside reloads itself once (gui.ts).
	// Unreleased to 355: the server reads the net while no page listens too (gui.ts: the idle reading), for the timeline.
	// Unreleased to 357: Straw Link's summary on the snapshot (net.ts: link) and the holder's channel to the page (gui.ts).
	assert.ok(sum("src", ["net.ts", "gui.ts"]) <= 357, `src/net.ts and src/gui.ts have ${sum("src", ["net.ts", "gui.ts"])} lines`);
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
	// Unreleased raised spawn.ts to 225 for the folder picker's new folder (makeDir: a plain visible name made inside a pickable folder) and its places (home, Desktop, Documents, the bases' folders), and added deploy.ts (63): an opening reports its steps (create, start, join, deliver) for the page to poll, and a refusal names its failed step.
	// Unreleased raised spawn.ts to 227: a folder made by a swapped link is taken back, and Windows-reserved names are refused.
	// 0.15.0 raised spawn.ts from 123 to 168: a base opens with a member and no tower, a base without a tower takes members (split into a squad or in
	// a new tab), only one with a tower takes mains, and every opening shares the start, join wait, first message, and close-on-failure.
	// Unreleased raised remote.ts to 203: paired devices saved (hashed) for the server a /reload starts again, and the disable that keeps them; host.ts to 88 for `restore`, which turns remote back on after a /reload.
	// Unreleased raised control.ts to 181 for dismiss: a finished subagent hidden from every page.
	// Unreleased raised tools.ts to 80 and session.ts to 148 for the tower's digest (digest.ts, 45 at most): boss_rename notes the new name, a join and a
	// subagent launch note themselves, and the tower's run reads the lines into its section and clears them.
	// Unreleased raised tools.ts to 87: boss_rename labels a main agent's tab itself (tabLabel and the rename), since pi-auto-tab-name leaves a tab someone else labelled.
	// Unreleased raised spawn.ts to 169: an opening answers with the session in its pane (sessionAt), so the page goes to it.
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
	// Unreleased raised ask.ts to 139: a unit that is idle while a subagent of it commands (by a monitor) commands too, after the loop; a running monitor makes an idle unit commanding.
	// Unreleased raised host.ts to 97: a new server resumes remote when it was wanted on (resume) and the page's remote off; to 105 for resuming only as the remembered Tailscale identity, and for a /reload from a build up to 0.32.1.
	// Unreleased raised control.ts to 191 for remote/off, remote/devices, remote/unpair, remote/unpair-all and dismiss {all} (the confirm refusal is gone), and remote.ts to 216 for
	// the wish to keep remote on, the unpair calls, and the renewing cookie check; the paired devices themselves (saved hashes, names, sliding expiry) are devices.ts, 95 at most (a failed save is caught and kept as `error`).
	assert.ok(count("src/devices.ts") <= 95, `src/devices.ts has ${count("src/devices.ts")} lines`);
	// Unreleased (stash and pop, docs/specs/2026-10-22-stash): stash.ts (221, new: Herdr's side of the check and its second look, the manifest checked before anything closes, stashBase on the server, popBase claiming the manifest on disk, with its start order, under the popping session's agent dir
	// and cleanup) and stashing.ts (46, new: /boss stash through the GUI server, /boss pop here) have figures of their own. bridge.ts 250 to 261 for `stash-check` (the session's
	// own reasons: a turn, a queue, a dialog, a running monitor), its answer, and a stash's close that is refused when the session stopped being stashable; dialogs.ts 237 to 240 for the hub's request and its answer; control.ts 198 to 199 for close/stash
	// and the refresh handed to it; handover.ts 93 to 111 for postServer, a POST to the recorded server as its page sends one; boss.ts 36 to 40 for stash, pop, and the stash names in Tab; closer.ts 70 to 71 for close/stash's batch asking `ifStashable`.
	// Unreleased (GUI takeover): handover.ts 111 to 166 for the record's `started` and `stopped`, the owner check a survivor decides on (ownerGone), and adoptGui with the lock shared with sharedGui; host.ts 111 to 152 for
	// the watch that adopts a server whose session ended without a stop, the mark a stop leaves, and the server's start taken out of `share`; state.ts 106 to 110 for the two dependencies (`gone`, `adoptMs`); session.ts 148 to 149 for the watch.
	// Unreleased (GUI takeover review): handover.ts 166 to 217 for `adoptable` (an old build's record, another Herdr's, a newer build's), the identity `markStopped` matches, `stopRecorded` (a stop under gui.lock), and `clearStale`
	// (a dead session's lock taken over by one session at a time); remote.ts 225 to 227 for the `plain` text a server that starts again prints; bridge.ts 261 to 262 for skipping a host whose process is gone.
	// Unreleased (close all): stash.ts 221 to 262 for closeAll (the invoker's own base checked as a stash checks it, looked at again before it closes, the server's session asked again when it sits there) and the check shared with it;
	// stashing.ts 46 to 58 for /boss close all through the server; closer.ts 71 to 74 for close/all; boss.ts 40 to 41 for its Tab entry.
	// Unreleased (GUI takeover, second review): handover.ts 217 to 230 for `keep` (a restore or a stash that leaves a stopped or down server alone under the lock), `downgrades` (a newer build's server, split out of `adoptable`), and `blind`; host.ts 152 to 164 for the
	// looks a survivor waits (a tower one, anyone else two, an older build three), the one warning when `ps` cannot read the start time, and `share` with `keep`; session.ts 149 to 150 for the Herdr check of the newer-version takeover; stashing.ts 58 to 62 for refusing a stopped server.
	// Unreleased (tower comms, docs/how-it-works.md "Talking between towers"): header.ts (31, new: the line every message opens with), closemain.ts (91, new: a tower asks a main it opened to quit, over the control channel; the main's own checks),
	// headwatch.ts (21, new: the digest line when the head tower changes). reach.ts 96 to 189 for the reading of the net and a message under its header (read, partyOf, deliver, post, callTower), the stations a message for a tower reaches (a tower, else mains, else members),
	// and tower_list and tower_send; tools.ts 87 to 101 for those tools and boss_close_main (and call_tower and boss_broadcast moving their bodies into reach); opener.ts 90 to 93 for the tower named in the handoff;
	// tower.ts 44 to 51 (a shutdown during the start stops it), session.ts 150 to 154 and state.ts 110 to 112 for their registration and the head watch.
	// Straw Link step 3: state.ts 112 to 113 for the `link` dependency (src/link/runtime.ts) tests shorten; tools.ts 101 to 109 for `device` on tower_send and the remote section of tower_list;
	// header.ts 31 to 43 for the verified sender of a remote message (remote=, device=, team=, verified=yes).
	// Straw Link step 4: owners.ts 145 to 148 for the remote-turn gate as a dialog owner (src/link/gate.ts); state.ts 113 to 115 for `remoteOrigin`; header.ts 43 to 47 for `origin=` on a message a tower sends during a remote turn.
	// Unreleased raised session.ts 160 to 171: the sub-workspace check at session start runs in the background, so pi-intercom connects without waiting for Herdr, with the barred-while-checking state, the guard against a later session start, and a subagent launch that waits for the answer.
	// Unreleased (comfort): activity.ts (47, new: when each unit took its state, its last steps, and the net's events of 30 minutes, kept across the server's reads, a reading after a gap a fresh start; no run-time import, so the demo runs it too) and todo.ts (29, new: a session's todo list in short from its branch, and the hub's check);
	// bridge.ts 262 to 275 for reading that todo list from the branch after each tool call, turn, and tree move and sending it when it changed; dialogs.ts 240 to 243 and ask.ts 141 to 143 for relaying it to its unit.
	// Unreleased (Herdr restore): roles.ts (63, new: the record each tower and main keeps of its role, by session file, pane, and tab, so a resumed pane takes it back); state.ts 112 to 115 (the session file and the restored flag),
	// membership.ts 115 to 120 (a main records itself, and a restored one does not open a second tower), tower.ts 51 to 54 (records and forgets), session.ts 171 to 178 (the record read at the start, a resumed main promoting, closing dropping it), and sidecar.ts 347 to 348.
	// Unreleased (merge of Straw Link step 3 and the Herdr restore): state.ts 115 to 116, the link dependency beside restoreMs; then 116 to 118 for the remote origin and the merge of step 4.
	// Unreleased (restore hardening): roles.ts 63 to 107 (the terminal and workspace a record must match, one main record a tab and the lookup of it, a sweep that cannot fail the write) and guard.ts 83 to 103 (the wait for the main a restore brings back), and session.ts 178 to 189 (the record read before joining, a stale main's record dropped, the restored flag reset when the start ends).
	// Unreleased: host.ts 164 to 170 for the page's channel to the link holder. tools.ts to 126 for link_request (its parameters and the call into the link module). control.ts 199 to 222 for the page's Straw Link calls (link/<name> to the holder, refused to a paired device unless it only reads).
	// Unreleased (restored opener): roles.ts 109 to 121 and session.ts 194 to 203, the marker of a main a tower opened kept in its role record and written back when a Herdr restore gives the main its role (the tower that opened it closes it again).
	// Unreleased (Windows hidden folders): spawn.ts 227 to 239 for the attribute reader the picker asks (listing, pickable, makeDir, the request wrapper), and hidden.ts (61, new: the cmd.exe reader, its cache, and the walk down a path).
	// Unreleased (Windows short names): spawn.ts 239 to 245, the path as given is read from home as the caller spelled it as well as from the real root (an 8.3 short name is rewritten by realpath).
	// Unreleased (desk mode R1): handover.ts 230 to 268 for gui.json written by rename (`writeRecordFile`) and the record written again when this process's start time arrives (`late`); startof.ts (99, new: the start time of a process, from `ps` or, on Windows, a PowerShell call read in the background, with the own-PID retries and the per-PID failure backoff).
	// Unreleased (the queue's Edit): control.ts 223 to 254 for the dequeue route (take id, the begin and finish around the key, the reasons told to the page), bridge.ts 275 to 320 and dialogs.ts 243 to 255 for the bridge's begin and finish (the queue mirror it checks the pulled text against, the deadline, the take-back it keeps for the same id asked again) and the hub's request, keys.ts 103 to 115 for Alt+Up under the guard and the rate, and pull.ts (37, new: how the pulled messages are told from the draft).
	// Straw Link GUI follow-up: control.ts 222 to 223 (a paired device's answer to a `hereOnly` choice is refused 403 local_only) and owners.ts 151 to 152 (`Choice.hereOnly` passes through selectOf).
	for (const [name, max] of [["commands.ts", 32], ["control.ts", 254], ["stash.ts", 284], ["stashing.ts", 62], ["closer.ts", 87], ["upload.ts", 50], ["spawn.ts", 245], ["hidden.ts", 61], ["deploy.ts", 63], ["remote.ts", 227], ["pairing.ts", 60], ["qr.ts", 140], ["ask.ts", 143], ["bridge.ts", 320], ["owners.ts", 152], ["dialogs.ts", 255], ["seal.ts", 56], ["monitors.ts", 75], ["activity.ts", 47], ["todo.ts", 29], ["order.ts", 97], ["mirror.ts", 135], ["probe.ts", 40], ["keys.ts", 115], ["pull.ts", 37], ["documents.ts", 80], ["docs.ts", 150], ["orphan.ts", 115], ["opener.ts", 93], ["handover.ts", 268], ["towertab.ts", 65], ["state.ts", 118], ["roles.ts", 121], ["briefing.ts", 33], ["reach.ts", 189], ["election.ts", 24], ["guard.ts", 110], ["presence.ts", 93], ["membership.ts", 131], ["tools.ts", 126], ["tower.ts", 54], ["closing.ts", 29], ["host.ts", 170], ["boss.ts", 41], ["session.ts", 203], ["digest.ts", 45], ["closemain.ts", 91], ["headwatch.ts", 21], ["header.ts", 47], ["intercept.ts", 175], ["endpoint.ts", 24], ["startof.ts", 99]] as const) assert.ok(count(`src/${name}`) <= max, `src/${name} has ${count(`src/${name}`)} lines`);
	// 0.19.0 to 258 for the todo list: rpiv-todo's snapshots marked as the index reads them, and the newest one read for a reset or a change that adds one.
	// Unreleased (net sidecar): composer.ts 191 to 192 and tokens.ts 23 to 24 for the agent badge and the composer's notice for a unit that is not a pi session.
	// Unreleased (net sidecar): src/agent/ holds the net sidecar of a Claude Code or Codex session (docs/specs/2026-10-23-claude-codex-net): kit.ts (the modules' two pi dependencies over a raw
	// intercom client), paths.ts (where its files and pi-intercom are), sidecar.ts (the session in the net), and cli.ts (what straw-boss runs: join, and the commands of straw-net.py). None of it is loaded by the extension or by the page, and none imports the host, the GUI, or the dialogs.
	// Unreleased (net sidecar review): claim.ts (45, new: the pane's state file claimed whole with a link, a leftover removed under a lock), paths.ts 78 to 106 (a holder is who answers on the socket, not a pid), cli.ts 147 to 158
	// (the wait per command, join through that holder), and sidecar.ts 332 to 347 (the shell-quoted hint, the relay marker and attachment note, the pi variables left out, a pane another agent has taken).
	// Unreleased (Windows): paths.ts 106 to 114, the control socket as a named pipe on Windows (a random name recorded in the state file, socketOf, and socketIsFile
	// for the steps a pipe skips); closing.ts 23 to 29, the wait for pi's exit in node on Windows, which has no sh.
	// Unreleased: cli.ts 158 to 160, the directory pi-intercom is looked for beside (`here`), so a test runs the same in a checkout next to a pi-intercom checkout.
	for (const [name, max] of [["kit.ts", 161], ["paths.ts", 114], ["sidecar.ts", 349], ["cli.ts", 160], ["claim.ts", 45]] as const) assert.ok(count(`src/agent/${name}`) <= max, `src/agent/${name} has ${count(`src/agent/${name}`)} lines`);
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
	const apart = ["startof.ts", "commands.ts", "dashboard.ts", "net.ts", "gui.ts", "history.ts", "items.ts", "watch.ts", "balance.ts", "control.ts", "remote.ts", "devices.ts", "pairing.ts", "qr.ts", "ask.ts", "blocked.ts", "bridge.ts", "owners.ts", "dialogs.ts", "seal.ts", "monitors.ts", "activity.ts", "todo.ts", "order.ts", "mirror.ts", "probe.ts", "pull.ts", "keys.ts", "documents.ts", "docs.ts", "orphan.ts", "opener.ts", "spawn.ts", "hidden.ts", "deploy.ts", "upload.ts", "closer.ts", "server-watch.ts", "handover.ts", "towertab.ts", "state.ts", "roles.ts", "briefing.ts", "reach.ts", "election.ts", "guard.ts", "presence.ts", "membership.ts", "tools.ts", "tower.ts", "closing.ts", "host.ts", "boss.ts", "session.ts", "intercept.ts", "digest.ts", "closemain.ts", "headwatch.ts", "header.ts", "stash.ts", "stashing.ts", "endpoint.ts"];
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
	// 0.27.0 to 234: index.ts (53, the listings over the socket unless a run is injected) and herdr.ts (181: socketRun, the listings' socket requests, and the world as one session.snapshot or as listings asked together).
	// 0.28.0 to 235: index.ts (54), the delay before a subagent's pane is read once Herdr reports a pi (`detectMs`).
	// Unreleased to 237: index.ts (56), the wrap of ctx.ui installed beside the bridge (its import and one call).
	// Unreleased to 238: index.ts (57), the tower's digest built beside the briefing (its import).
	// Unreleased to 239: index.ts (58), /boss stash and pop built beside /boss (its import).
	// Unreleased to 241: index.ts (60), the two dependencies of the GUI takeover (`gone` with its import, `adoptMs` with its default).
	// Unreleased to 243: herdr.ts, `herdrSocket`, the socket a session's Herdr is named by, which the watches default to and gui.json records.
	// Unreleased to 244 (net sidecar review): herdr.ts, the `stderr` a failed herdrRun carries, so a caller reads Herdr's own code and not the line the message repeats.
	// Unreleased to 246 (tower comms): index.ts (62), the control channel and the head watch wired in (createCloseMain, its handing to the tools, the session, and the tower).
	// Unreleased to 248 (Windows): herdr.ts, the import of endpoint.ts (24, its own figure: Herdr's socket found as Herdr finds it, and a named pipe on Windows).
	// Unreleased to 269: herdr.ts, `pane current` and `report-metadata` over the socket too (socketRun, was socketReads), so a session start and the token refreshes spawn no Herdr CLI.
	// Straw Link step 3: 269 to 270 for index.ts importing createLink.
	// Unreleased to 270 (Herdr restore): index.ts (63), roles.ts built beside the briefing and handed to the membership, the session, and the tower (its import).
	// Unreleased to 273 (desk mode R1): index.ts (66), startof.ts imported and warmStart called at the session's start.
	assert.ok(rest <= 273, `the rest of src has ${rest} lines`);
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
	// Unreleased raised workspace.ts to 60 for the tower's subagents tethered under it.
	// Unreleased raised session.ts to 116: the comms head carries the unit's mark, so it glows while the unit is commanding.
	// Unreleased raised scene.ts to 38 for `closed` (a channel is closed when its session left the net or a finished subagent's pi exited) and composer.ts to 191 (a closed channel's box is disabled).
	// Unreleased raised scene.ts to 41 and session.ts to 121: a tower's comms head carries "+ Main", the map's opening button aimed at the tower's base.
	// Unreleased raised layer.ts to 250: fit() watches a gauge of the work's width, not the work, whose height changes inside the map's packing report.
	// Unreleased raised session.ts to 124, bars.ts to 85, and composer.ts to 294: the queue's Edit (its bar, its wiring, and the composer's take-back with its id, the reply stored for a composer that is gone, and the rows opened per session).
	for (const [name, max] of [["router.ts", 80], ["chat.ts", 277], ["markdown.ts", 180], ["views.ts", 90], ["scene.ts", 41], ["tokens.ts", 24], ["nav.ts", 43], ["workspace.ts", 60], ["dossier.ts", 49], ["session.ts", 124], ["bars.ts", 85], ["lightbox.ts", 34], ["layer.ts", 250], ["askkeys.ts", 75], ["composer.ts", 295], ["ask.ts", 185], ["mirror.ts", 175], ["keypad.ts", 124], ["doc.ts", 108], ["i18n.ts", 50], ["slash.ts", 63]] as const) assert.ok(count(`gui/${name}`) <= max, `gui/${name} has ${count(`gui/${name}`)} lines`);
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
	// Unreleased to 157 for the alert ranking: only a unit waiting on the user (or with a dialog pending) is prominent; an error and a failed monitor are notices, and rankOf reads the alert.
	assert.ok(overlay <= 157, `the overlay model has ${overlay} lines`);
	const demo = sum("gui", ["fixture.ts", "demo-chat.ts"]);
	// 0.5.0 raised it from 160 to 165 for a demo question and a demo secret; 0.6.0 to 170 for a demo robot_hand selector and questionnaire that answer;
	// 0.6.1 to 174 for a demo tool call whose arguments show cut (with the whole of them for "show all arguments"), an answerable dialog that stays
	// until it is answered, and a toolbar that folds to a tab in the margin on a phone.
	// 0.7.0 to 190 for a demo terminal: a pane whose screen changes every second while a terminal tile shows it, and the stream's hello.
	// 0.28.0 to 191 for a demo secret that answers (n % 4 == 1) beside the one that only waits in the terminal.
	// Unreleased (comfort) to 197: the server's activity tracker over each demo snapshot, half an hour of history played at the start, tools that vary, and todo lists.
	// Unreleased to 199: the demo's folder picker and deploy stand in for the server (gui/demo-open.ts, its own figure), installed by the fixture.
	assert.ok(demo <= 199, `the demo fixture has ${demo} lines`);
	// 0.13.0 raised views.ts to 253 for the base view's two opening buttons; the opening tile (gui/spawn.ts) has its own figure below.
	// 0.15.0 raised composer.ts to 190 for files: pasted, dropped, or picked, each uploaded and its path put in the message.
	// 0.15.0 to 254 for the squads' + Member buttons, and gui/spawn.ts to 68 for the new base, member, and squad member tiles and the button reader.
	// Unreleased to 58: the folder picker moved to gui/picker.ts, the opening tile keeps its form (name, first message, open) and the deploy panel, from 75 for the deploy panel taking the form while a unit opens (the panel itself is gui/deploy.ts, 114, with the demo's stand-in server in gui/demo-open.ts, 35).
	// Unreleased deploy.ts to 124: the timeout measures silence, a late ok still shows ready, and closing the tile stops it.
	assert.ok(count("gui/deploy.ts") <= 124 && count("gui/demo-open.ts") <= 46, "the deploy panel and its demo stay small");
	// Unreleased: the folder picker the opening tiles share is Finder's column view: its state (gui/folders.ts: the columns of the selected folder's levels, arrow keys, back and forward, new folder) and its drawing (gui/picker.ts: toolbar, shortcuts, columns, path).
	assert.ok(count("gui/folders.ts") <= 126 && count("gui/picker.ts") <= 95, "the folder picker stays small");
	assert.ok(count("gui/spawn.ts") <= 59, `gui/spawn.ts has ${count("gui/spawn.ts")} lines`);
	// The phone pairing tile and the write helper it shares with the composer (0.5.0, no figure in the spec).
	const pairing = sum("gui", ["pair.ts", "post.ts"]);
	// 0.15.0 to 55 for post.ts sending a file's bytes to a session's upload. Unreleased to 58: the paired devices under the code (devices.ts, 31 at most, its own figure).
	assert.ok(count("gui/devices.ts") <= 31, `gui/devices.ts has ${count("gui/devices.ts")} lines`);
	assert.ok(pairing <= 58, `the pairing tile has ${pairing} lines`);
	// Unreleased: the answer form's keys (gui/askkeys.ts: arrows, Tab, Enter, and Space between options, questions, own words, and Send, one tab stop per group) have a figure of their own,
	// and layer.ts went to 249 for the dialog that takes the focus on its first option instead of Open comms (4 lines).
	// Unreleased: the dialogs' keys (Space opens the next alert, F enlarges the top dialog; gui/hotkeys.ts: the routing and its listeners) have a figure of their own,
	// and layer.ts went to 245 for the hotkey entry both keys reach (13 lines); hotkeys.ts went to 50 for the pointer-focus tracking that lets Space through on a control the mouse left focused.
	assert.ok(count("gui/hotkeys.ts") <= 50, `gui/hotkeys.ts has ${count("gui/hotkeys.ts")} lines`);
	// The phone drawer (Unreleased): its gesture rules (swipe.ts, apart from the DOM so they are tested) and the list with its touch wiring (drawer.ts) have a figure each.
	assert.ok(count("gui/swipe.ts") <= 40, `gui/swipe.ts has ${count("gui/swipe.ts")} lines`);
	// Unreleased to 167: a finished subagent's card swiped to the right is dismissed (the card's drag, its release, and quit.ts's dismiss).
	// Unreleased to 172: the drawer's way back to the map and its Dismiss finished button.
	// Unreleased to 194: the tower as a row of two buttons (icon, +), Quit on an idle main, and the way back to the map in the drawer's foot.
	assert.ok(count("gui/drawer.ts") <= 194, `gui/drawer.ts has ${count("gui/drawer.ts")} lines`);
	// Unreleased (comfort): the timeline under the stage (gui/timeline.ts: a mark per event of the net's last 30 minutes, placed by its time, named on hover, a link to its unit)
	// and the map's overview in a corner (gui/minimap.ts: shown while the map runs past the window, its frame moved on a scroll) have a figure each.
	assert.ok(count("gui/timeline.ts") <= 42, `gui/timeline.ts has ${count("gui/timeline.ts")} lines`);
	assert.ok(count("gui/minimap.ts") <= 44, `gui/minimap.ts has ${count("gui/minimap.ts")} lines`);
	const shipped = new Set(["timeline.ts", "minimap.ts", "swipe.ts", "drawer.ts", "router.ts", "chat.ts", "lightbox.ts", "follow.ts", "markdown.ts", "views.ts", "scene.ts", "tokens.ts", "nav.ts", "workspace.ts", "dossier.ts", "session.ts", "bars.ts", "layer.ts", "alerts.ts", "overlay.ts", "fixture.ts", "demo-chat.ts", "composer.ts", "pair.ts", "devices.ts", "spawn.ts", "deploy.ts", "demo-open.ts", "folders.ts", "picker.ts", "post.ts", "ask.ts", "mirror.ts", "keypad.ts", "doc.ts", "i18n.ts", "slash.ts", "hotkeys.ts", "askkeys.ts"]);
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
	// Unreleased to 835: quit.ts aims a finished subagent's button at Dismiss and posts it without asking.
	// Unreleased to 840: render.ts's `say`, which flags a unit's note red while it only waits on a running monitor.
	// Unreleased to 841: render.ts draws a tower's subagents under its base's header.
	// Unreleased to 852: quit.ts counts the finished subagents and draws the HUD's Dismiss finished button (endedSubs, showDismissAll), main.ts calls it.
	// Unreleased to 853: the commanding mark's HUD figure and glow flag (render.ts), and the packets' live check.
	// Unreleased to 862: main.ts loads the phone drawer (drawer.ts) where there is a touch screen or a narrow window and hands it each snapshot and route; the demo's toolbar gets a drawer button.
	// Then to 863 for the alert ranking (alerts.ts: waiting or a pending dialog is prominent, the rest are notices).
	// Unreleased to 888 for stash and pop on the map (quit.ts: aimStash, showStashed and its Pop buttons, Stash and Pop in the click handler; render.ts and main.ts wire them, and hang the Stashed list under its button).
	// Unreleased (net sidecar) to 891: render.ts holds the agent labels and the badge on the card.
	// Unreleased (comfort) to 901: render.ts packs the bases like masonry (a ResizeObserver spanning each card's rows) and publishes the header's height (--hud) for what sits under it; main.ts names the view on the stage.
	// Unreleased to 1389 (1385 for Straw Link, 4 for the session view's Quit): Straw Link's page code (link.ts: the team settings tile; linkbar.ts: the header's notices and the forwarded confirm; linkmodel.ts: their words and marks; render.ts: the teammates' bases).
	// Unreleased to 906: quit.ts aimSession, the Quit in a unit's comms header (leave exported for its test).
	assert.ok(page <= 1389, `the page's TypeScript has ${page} lines`);
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
	// Unreleased to 38.1 KB for an opening tile that closes and goes to the session it opened (main.ts).
	// Unreleased to 38.2 KB / 14.55 KB gzipped for the note of a unit kept working by a running monitor, in both languages.
	// Unreleased to 38.75 KB / 14.7 KB gzipped for Dismiss on a finished subagent (quit.ts), in both languages.
	// Unreleased to 38.85 KB for `say`: the note of a unit that only waits on a running monitor flagged red wherever it shows.
	// Unreleased to 39.05 KB / 14.75 KB gzipped for a tower's subagents on the map: under its base's header, and counted in the totals, alerts, and log.
	// Unreleased to 39.5 KB / 14.85 KB gzipped for the HUD's Dismiss finished (quit.ts: the finished subagents counted, the button shown and labelled) in both languages.
	// Unreleased to 40 KB / 15 KB gzipped for the commanding mark (its label, HUD figure, and glow hooks) in both languages.
	// Unreleased to 40.5 KB / 15.2 KB gzipped for loading the phone drawer (main.ts) and the glow of the commanding mark's neighbours (labels shared with the drawer).
	// Unreleased (stash and pop on the page): stash.ts 262 to 284 (stashedList, close all naming its base; nameFor, the server's session asked again before its base is stashed, a failed pop never stashed over another), closer.ts 74 to 87 (close/pop), host.ts 110 to 111 (the import of
	// popBase and stashedList). The map chunk to 42.7 KB / 15.8 KB gzipped for stash and pop on the map (quit.ts: a base's Stash, the HUD's Stashed list with Pop, Quit checked first) in both languages.
	// Unreleased (net sidecar) to 42.8 KB / 15.85 KB gzipped for the agent badge on a unit that is not a pi session (the card and the token).
	// Unreleased (comfort) to 43.25 KB / 16 KB gzipped for the bases packed like masonry and the header's height published for what sits under it (render.ts).
	// Unreleased (comfort) to 47.05 KB / 17.25 KB gzipped for what a card says it did lately (its clock, its todo in short, its last steps) and the cards' clock, the timeline (timeline.ts) in place of the net log, and the map's overview (minimap.ts), with their messages in both languages.
	// 0.42.0 (calm header) to 47.2 KB: the settings panel's button (its name in both languages, where it hangs).
	// Unreleased to 47.25 KB / 17.3 KB: the links and the overview drawn on the next frame after the cards' packing, not by an observer of the map.
	// Unreleased to 47.35 KB / 17.31 KB: the comms' Back steps back through the page's own history (router.ts depthOf, data-back).
	// Unreleased to 47.4 KB / 17.33 KB: quit.ts's dismiss shared with the drawer's swipe.
	// Unreleased to 47.45 KB / 17.36 KB: Notifier.chime, the unit-ready sound of the deploy panel (the panel and its messages are in the opening tile's lazy chunk).
	// Unreleased to 53.15 KB / 19.05 KB (Straw Link 53 KB, the session view's Quit the rest): Straw Link's part of the map (linkbar.ts: the header's notices and the forwarded confirm; linkmodel.ts: their words, the invite's countdown, an ally's mark; render.ts: the teammates' bases) and its messages in both languages. The team settings tile itself is a lazy chunk.
	// Unreleased to 47.65 KB / 17.45 KB: the session view's Quit (quit.ts aimSession, the map's own Quit aimed at the unit in view); chat.ts 275 to 277 and session.ts 121 to 122 lines for the role label on a message and the Quit.
	assert.ok(size(entry).length <= 53_150 && gz(entry) <= 19_050, `the map chunk is ${size(entry).length} bytes (${gz(entry)} gzipped)`);
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
	// Unreleased to 101.7 KB / 41.9 KB gzipped for the notices list's plural and the Notices button's tint, after 101.5 KB / 41.8 KB for the phone drawer (gui/drawer.ts and swipe.ts, about 4 KB raw, with their messages in both languages), after 96 KB / 38.8 KB for the paired devices under the pairing code (gui/devices.ts, with its messages in both languages) and the answer panel without its read-only confirm.
	// Unreleased (net sidecar) to 102 KB / 41.95 KB gzipped for the composer's notice about an agent that is not pi (both languages).
	// Unreleased (comfort) to 41.98 KB gzipped: the lazy chunks import the map chunk by its hashed name, and a new hash gzips a few bytes differently.
	// Unreleased to 102.05 KB / 42 KB gzipped: layer.ts watches a gauge of the work's width (the gauge made and observed), and the column template's agent slot.
	// Unreleased to 102.1 KB: the comms' Back marked data-back, to step back through the page's history.
	// Unreleased to 102.8 KB / 42.25 KB gzipped: the drawer's swipe to dismiss a finished subagent's card (gui/drawer.ts).
	// Unreleased to 103.2 KB / 42.55 KB gzipped: a tower's comms head carries "+ Main" (gui/session.ts, scene.ts).
	// Unreleased to 103.5 KB / 42.7 KB gzipped: the drawer's map link and Dismiss finished button (gui/drawer.ts, with its message in both languages).
	// Unreleased to 113 KB / 46.3 KB gzipped: the folder picker (gui/picker.ts, folders.ts), nine more messages in both languages; and
	// Unreleased to 107.7 KB / 44.4 KB gzipped: the deploy panel (gui/deploy.ts: steps, bar, clock, finish, failure), its demo server, and its twelve messages in both languages.
	// Unreleased to 113.6 KB / 46.6 KB gzipped: the deploy panel measures silence, and closes with its tile; the picker lands on a column edge.
	// Unreleased to 135.4 KB / 55.15 KB gzipped: the team settings tile (gui/link.ts, its own lazy chunk: forms, roster, invite with its QR, the safety words, the camera) and its messages in both languages.
	// Unreleased to 135.95 KB / 55.3 KB gzipped: the leave confirm for an only admin and the page's label and share prefill (gui/link.ts), the session view's Quit.
	// Unreleased to 136.1 KB / 55.4 KB gzipped: a choice only this computer may give (`hereOnly`) is shown disabled on a paired device (gui/ask.ts).
	// Unreleased (queue Edit, on top of the drawer's) to 141.5 KB / 57.25 KB gzipped: the queue's Edit (its bar and wiring, the composer's take-back with its id and the reply kept for a composer that is gone, seven messages in both languages).
	// Unreleased to 137.1 KB / 55.7 KB gzipped: the drawer's tower row (icon and +), Quit on an idle main, and the map link in its foot (gui/drawer.ts).
	assert.ok(chunks.length >= 1 && total(chunks, (n) => size(n).length) <= 141_500 && total(chunks, gz) <= 57_250, `the chat chunks are ${total(chunks, (n) => size(n).length)} bytes (${total(chunks, gz)} gzipped)`);
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
	// Unreleased to 48.7 KB / 11.8 KB gzipped for the paired devices list on the pairing tile, then to 50 KB / 12 KB for the commanding mark's colour, badge, and glow, and to 51.8 KB / 12.4 KB for the phone drawer.
	// Unreleased to 52 KB / 12.45 KB for the base's Stash beside its Quit and the Stashed list's rows.
	// Unreleased (net sidecar) to 52.2 KB for the agent badge.
	// Unreleased (comfort) to 58 KB / 13.1 KB gzipped: every colour a palette token (color-mix of a token is longer than the literal it replaced), the location bar with the legend, the footer, masonry rows, and Quit shown on hover.
	// Unreleased (comfort) to 60 KB / 13.45 KB for the comfort effects: a card's lift and its glow in a new state, presses, the tethers' arrowheads and their flow (resting when the page calms), selection and scrollbar colours.
	// Unreleased (comfort) to 62.6 KB / 13.95 KB for the timeline's marks, rows, and hover names, a card's clock, todo, and step marks, and the overview, less the net log's rules.
	// Unreleased (calm header) to 63.4 KB / 14.1 KB: the totals as one strip, the settings button and panel, the map's actions in the location bar.
	// Unreleased to 63.45 KB: the work's gauge (layer.ts watches its width) and the work positioned for it.
	// Unreleased to 63.7 KB / 14.13 KB: a phone's comms play their entrance themselves, not on their view (whose transform held them under the HUD), and "opening the channel" covers the screen.
	// Unreleased to 14.14 KB gzipped: the drawer's current unit marked on both edges.
	// Unreleased to 63.95 KB / 14.2 KB: the drawer's finished card following the finger and sliding out when dismissed.
	// Unreleased to 64.05 KB / 14.25 KB: the "+ Main" button in a tower's comms head, and a fifth column for it on a phone.
	// Unreleased to 64.45 KB / 14.3 KB: the drawer's map link and Dismiss finished row.
	// Unreleased to 71 KB / 15.45 KB: the folder picker (toolbar and breadcrumb, shortcuts, the columns, the one column of a narrow window); and
	// Unreleased to 68 KB / 14.95 KB: the deploy panel (bar, step list, running pulse, finish and failure tints, its keyframes).
	// Unreleased to 75.1 KB / 16.35 KB gzipped (Straw Link 75 KB / 16.3 KB, the session view's Quit the rest): Straw Link (the teammates' bases, the notices, the team settings tile with its roster, invite, and join forms).
	// Unreleased to 71.2 KB / 15.55 KB: the session view's Quit in the comms header (desktop and phone grid).
	// Unreleased (queue Edit, on top of the drawer's) to 76.65 KB / 16.6 KB gzipped: the queued row's clamp on a box inside the padded row and the queue's Edit line.
	// Unreleased to 76.2 KB / 16.5 KB: the phone drawer's tower row, its Quit, the map link's foot, and no selection in the drawer.
	assert.ok(total(css, (n) => size(n).length) <= 76_650 && total(css, gz) <= 16_600, `the stylesheet is ${total(css, (n) => size(n).length)} bytes (${total(css, gz)} gzipped)`);
});
