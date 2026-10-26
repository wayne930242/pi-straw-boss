# Project trust from the GUI

Status: approved by the author 2026-10-26 with every recommendation in **Decisions** except D3, where the author chose the alternative (paired devices answer too); no upstream pi issue (D2). Not built.
Base: pi-straw-boss `main` at `8351041` (desk mode R1 merged), pi 1.4.0, Herdr 0.9.5, pi-intercom 0.17.1.
Asked for by the author (2026-10-26): an agent that must confirm project trust before it starts has no place in the GUI to confirm it; the question should reach the user as an alert, with the trust options to choose from.

## Intent

A pi started in a folder with project resources stops at pi's own trust prompt before it loads anything of that folder.
The prompt is drawn only in the pane's terminal, so a PM who uses only the GUI (straw-boss-desk, where no terminal is shown) sees an opening hang until the deploy panel fails it after 60 s, and an agent opened by a tower or brought back by a Herdr restore just never appears.
This change asks the same question in the GUI as an alert while the terminal keeps its way to answer, and the first answer wins.
With no GUI running nothing changes: pi asks in its terminal as it does today.

## Scope

- In:
  - A `project_trust` handler in pi-straw-boss that relays pi's startup trust question to the running GUI server.
  - A channel that works before the session has joined the net (no intercom yet).
  - The terminal side and the race with the GUI.
  - The alert: what it shows and offers, and who may answer it.
  - The openings that wait for a new pi (the page's opens, `boss_open_main`, a tower's start, a pop) waiting through a trust question; the deploy panel's trust step.
  - Desk mode, the team profile's `defaultProjectTrust`, timeouts, tests, acceptance, rollout.
- Out:
  - Session replacement into another folder (`/new`, `/resume`, `/fork` across folders; pi emits `project_trust` again there): pi's own prompt, unchanged (D10).
  - Pi's "Trust parent folder" choice: the terminal keeps it; the GUI does not offer it (D4).
  - Revoking a remembered decision from the GUI: `/trust` in a pane, or editing `trust.json`, as today.
  - Pre-trusting the repositories a switchboard clones: the switchboard's own spec.
  - A Herdr `blocked` mark on the pane while it waits: Herdr's pi integration reports a pane only from `session_start` on, and nothing here depends on it.
  - Outside Herdr (no `HERDR_PANE_ID`): no relay, as for every other dialog.
  - Print, JSON, and RPC modes: pi never asks there, and the handler stays out of it.

## Reality anchor

- **pi's order** (`dist/core/project-trust.js`, `resolveProjectTrusted`): a `--approve`/`--no-approve` override, then no protected resources means trusted, then the `project_trust` event, then the saved decision in `<agent dir>/trust.json` (the closest of the folder and its parents), then `defaultProjectTrust` (`ask`, `always`, `never`; agent-dir settings only), then the built-in prompt when there is a UI.
  The event comes before the saved decision and the default, so a handler that answers `yes` or `no` overrides both; one that answers `undecided` falls through.
  Only user-level and command-line extensions get the event (docs `extensions.md`), so pi-straw-boss installed per project never sees it.
- **The event** (`dist/core/extensions/types.d.ts:535`): `{type: "project_trust", cwd}`; the context is `{cwd, mode, hasUI, ui: select/confirm/input/notify}`; the result is `{trusted: "yes" | "no" | "undecided", remember?}`, and `remember: true` makes pi save `trusted` for `cwd` itself.
  The first handler that answers `yes` or `no` decides (`emitProjectTrustEvent`, `dist/core/extensions/runner.js:107`).
- **When it fires**: at process start, after user extensions loaded and before `session_start` (`dist/main.js:590`, `createRuntime`); a `/reload` reuses the process's decision (`projectTrustByCwd`) and does not ask again; a new process (a Herdr restore, `pi --session`, a pop) asks again unless the decision was remembered.
- **The startup UI cannot be dismissed.** At process start `ctx.ui.select` is `showStartupSelector` (`dist/cli/project-trust.js:9`, `dist/cli/startup-ui.js`), a TUI of its own that takes neither an abort signal nor a timeout and holds the terminal until a key resolves it.
  So the handler cannot open pi's prompt and close it again when the GUI answers, which is how `src/intercept.ts` races every later dialog.
  pi itself reads one raw key from stdin before its TUI starts (`showDeprecationWarnings` in the bundle: `setRawMode(true)`, `resume`, `once("data")`, `setRawMode(false)`, `pause`).
- **pi's own options** (`getProjectTrustOptions`, `dist/core/trust-manager.js`): Trust (saved), Trust parent folder (saved for the parent), Trust (this session only), Do not trust (saved), Do not trust (this session only).
- **Protected resources** (`hasTrustRequiringProjectResources`, exported; `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES`, not exported): `.pi/` `settings.json`, `mcp.json`, `extensions`, `skills`, `prompts`, `themes`, `SYSTEM.md`, `APPEND_SYSTEM.md`, and `.agents/skills` in the folder or any ancestor except `~/.agents/skills`.
  `ProjectTrustStore`, `SettingsManager` (`getDefaultProjectTrust`), and `getAgentDir` are exported from `@earendil-works/pi-coding-agent`.
- **Nothing of the net exists yet.** pi-intercom connects at `session_start` (`pi-intercom/index.ts:2058`); the dialog bridge follows `gui.json` and registers its channel from `session_start` (`src/bridge.ts:233`); the wrap of `ctx.ui` binds a dialog to the one tool call in flight (`src/intercept.ts`). A pane at the trust prompt has no `agent_session` either, so the net leaves it out even as an outside unit (`src/net.ts:80-81`).
- **The factory runs first.** `createStrawBoss` returns at once outside Herdr (`src/index.ts`), registers the bridge and the wrap, then returns for a subagent (`src/index.ts:51`); a handler registered before that line reaches every pi in Herdr, subagents included.
- **The state directory** is `$PI_CODING_AGENT_DIR/straw-boss` (`src/state.ts:115`); `gui.json` there names the server (port, token, PID, `started`, `herdr`, `version`) and is written by rename with Windows retries (`writeRecordFile`, `src/handover.ts:44`); `answers(record)` checks that the server answers (`src/handover.ts:142`).
- **Waits that would fail**: the page's opens wait 60 s for the new pi to join (`JOIN_WAIT_MS`, `src/spawn.ts:23`) and then close what they created; so do `boss_open_main` (`MAIN_WAIT_MS`, `src/opener.ts:8`), a tower's start (`TOWER_WAIT_MS`, `src/towertab.ts:5`), and a pop (`JOIN_MS`, `src/stash.ts:21`); the page gives up on a deploy after 120 s (`TIMEOUT_MS`, `gui/deploy.ts:30`); one opening runs at a time (`src/spawn.ts:231`).
- **The deploy panel** shows the server's steps `create`, `start`, `join`, `deliver` (`StepId`, `src/deploy.ts:5`) and never makes a step up.

## How it works

### The handler

`src/trust/ask.ts` registers `pi.on("project_trust", …)` in `createStrawBoss` before the subagent return.
It answers `undecided` at once, so pi goes on exactly as without it, unless all of these hold:

1. `ctx.mode === "tui"`, `ctx.hasUI`, and `process.stdin.isTTY` with `setRawMode`.
2. It is the process's first runtime: no `session_start` has run in this process yet (a process-wide `Symbol.for("pi-straw-boss.started")` set at the first `session_start`; a replacement runtime is a new copy of the module). Otherwise D10.
3. No saved decision applies: `new ProjectTrustStore(getAgentDir()).get(cwd)` is `null`. A store that throws (a broken `trust.json`) counts as a decision: pi then reports the error itself.
4. `defaultProjectTrust` is `ask`: `SettingsManager.create(cwd, getAgentDir(), {projectTrusted: false}).getDefaultProjectTrust()`.
5. A GUI that reads trust requests is running for this Herdr: `gui.json` is not `stopped`, carries `trust: 1`, names this pi's Herdr socket (`herdr`), and `answers` within 1 s.

Conditions 3 and 4 keep pi's order intact: the handler never decides what a saved decision or the default would have decided.
The cost when a GUI runs is one stat, two small reads, and one local GET, and only for a folder that needs a decision anyway.

### The pre-join channel: files in the state directory

The asking pi and the server talk through `<state>/trust/` (mode 700, files 600 where the OS has modes), D1.

```text
<id>.json         request   written by the asking pi (by rename), removed by it when decided
<id>.answer.json  answer    written by the server (by rename), read and removed by the asking pi
<id>.result.json  result    written by the asking pi just before it returns, removed by the server after 2 min
```

Request (version 1):

```json
{ "version": 1, "id": "<uuid>", "pid": 4242, "started": "<start time or absent>", "herdr": "<socket path>", "pane": "<HERDR_PANE_ID>",
  "role": "member|main|tower|subagent|none", "cwd": "<canonical folder>", "at": 1793000000000, "found": [ ... ], "digest": "<sha256>" }
```

- `role` is what the pane was opened as (`STRAW_BOSS_ROLE`, or `subagent` when `PI_SUBAGENT_ID` is set), shown as a hint only.
- `found` lists what trusting would load, read by the asking pi from its own folder (`src/trust/found.ts`), one group per resource, each `{kind, path, items, more}`:
  - `.pi/settings.json`: the `packages` sources (pi installs the missing ones), and the `extensions`, `skills`, `prompts`, `themes` paths it adds; other keys as a count.
  - `.pi/mcp.json`: each server as `name: command args` or `name: url`.
  - `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`: entry names.
  - `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`: present.
  - each `.agents/skills` from the folder up (path relative to the folder, e.g. `../.agents/skills`): skill names.
  - A file that cannot be read or parsed is listed as such.
  At most 20 items per group, 120 characters per item, 32 KB per request; `more` counts what was cut.
- `digest` is `sha256(["pi-trust/1", cwd, found])`; an answer must carry it.
- `started` comes from `startOf` (`src/startof.ts`) when it is known by then (on Windows it may not be yet); the server then checks the PID alone.

The server (the session that runs the GUI, `src/trust/serve.ts`) reads the directory on each net reading (every 2 s with a page, 10 s without) and on `fs.watch` events, and lists a request only while:

- its `herdr` is the server's own Herdr socket;
- its process lives (`runs`, with `started` when the request has it);
- Herdr lists its pane, in a workspace of this net.

A request whose process is gone is removed by the server, so a pi killed while waiting leaves nothing behind.
Every server that reads the directory writes `trust: 1` into `gui.json` (condition 5), so a pi never waits on a server of an older build.

Why files: intercom is not there yet; a request to the server's HTTP listener would add a new kind of caller to it, with its own authentication, and would break on every takeover; a file survives a takeover (the next server reads the same directory), costs no new transport, works the same on Windows, and lets the waits in towers and the opener read it too (**Openings**).
It adds no power to a same-user process: one that can write an answer file could write `trust.json` already.

### The terminal side and the race

Because pi's startup prompt cannot be dismissed (Reality anchor), the terminal does not show it while the GUI asks (D2).
The handler writes the request, then prints:

```text
Trust project folder? <cwd>
The question is in the Straw Boss window.
Press any key to answer here instead.
```

and reads one key in raw mode, as pi does for its deprecation notice, while it watches the directory for its answer (`fs.watch`, and a stat every 500 ms).
The asking pi decides which side came first, by the order its own event loop sees them:

- **The GUI first.** An answer file with this request's `id` and `digest` and a known choice: the handler stops reading (raw mode off, stdin paused, its listener removed), prints one line (`Answered in the Straw Boss window: trusted, remembered.`), writes the result (`by: "remote"`, the `answerId`), removes the request and the answer, and returns the mapped result (**What the alert offers**). pi does not show its prompt.
- **The terminal first.** A key: the handler consumes it, removes the request (and an answer that arrived meanwhile, unread), writes the result (`by: "terminal"`), and returns `undecided`. pi then shows its own prompt with all its options, as today. The page's alert closes as "answered in the terminal".
- **The GUI went away.** No server answers for 15 s (checked every 2 s with `answers`): the handler withdraws the same way (`by: "gone"`), prints `The Straw Boss window is not running; answer here.`, and returns `undecided` (D9).
- **pi is quitting.** A `SIGINT` or `SIGTERM` while waiting removes the request (a process `exit` hook) before pi exits as it would.

No answer times out: pi's own prompt waits forever too, and an agent should not trust or distrust a folder because nobody looked (D6 covers the openings that wait).

### What the alert shows

The snapshot gains `trust?: TrustAsk[]` beside `stashed` (`src/net.ts:27`), one entry per folder and digest (D8):

```ts
interface TrustAsk { id: string; digest: string; folder: string; found: Found[]; agents: { pane: string; base?: string; tab?: string; role: string; at: number }[]; opening?: string }
```

Text is cleaned as relayed dialogs are (Unicode format characters drawn as U+FFFD, control characters removed); `base` and `tab` are the labels Herdr gives the pane; `opening` names the page's opening that waits on it (**Openings**).

The page raises it as a question (rank 0 in `gui/alerts.ts`): it counts in the HUD's alert, Space opens it, a reminder says "An agent needs your OK to load a folder's settings", and Sound plays the waiting clip.
The dialog:

- Title: **Trust this folder?**, the folder's full path, and where the agent runs ("member in base X, tab Y"; "3 agents" when several wait on the same folder).
- One paragraph: trusting lets the agent load this folder's settings, extensions, skills, prompts, themes, and MCP servers, and install the packages its settings name; extensions and MCP servers run as programs on this computer; don't trust a folder you don't know the origin of.
- The `found` groups, folded to their counts past 5 items, with "and N more".
- The three choices, and a note that the agent's terminal can answer too and the first answer counts.

Strings go into the paraglide messages in English and Traditional Chinese.

### What the alert offers

| Choice (en / zh-TW) | Result | pi then |
|---|---|---|
| **Trust** / 信任這個資料夾 | `{trusted: "yes", remember: true}` | loads the folder and saves `true` for it in `trust.json` |
| **Trust this time** / 只信任這一次 | `{trusted: "yes"}` | loads it for this process only; the next pi there asks again |
| **Don't trust** / 不信任 | `{trusted: "no"}` | skips the folder's resources for this process only (D4) |

### Who may answer

`POST /<token>/api/trust/answer {id, digest, choice: "trust" | "once" | "no", answerId}` under the page's usual checks (origin, `Sec-Fetch-Site`, CSRF, 64 KB).
Decided (D3): this computer's page and a paired device may answer, as they may answer a relayed confirm; the remote listener takes the answer only from a paired device's authenticated session, under the same checks as its other writes.
A Straw Link peer never answers: trust requests are not in presence, and no link message can reach this route.
The author weighed the risk: trust runs the folder's extensions at load, before any gate of this extension exists, and a remembered `yes` holds for every later agent in that folder; the alert therefore names the folder and the resources plainly on every device.

The server takes one answer per request (in memory, since one server runs per machine), writes the answer file for every listed request of that folder and digest, and waits up to 5 s for their results:

- `accepted` when one result says `remote` with this `answerId`;
- `stale` (`by: terminal` or `gone`) when the terminal or the end of the pi came first;
- `unknown` when no result came in 5 s (the pi is slow; its result still closes the alert).

A second answer for the same request gets `busy`; an unknown `id` or a digest that no longer matches gets 409 `stale`.

### Openings

A new pi that waits on a trust question has not joined, so every wait for a new pi stops counting while its pane has a listed request.
One helper (`waitPastTrust` in `src/trust/wait.ts`) wraps the existing `waitFor` in `src/spawn.ts` (`boot`), `src/opener.ts`, `src/towertab.ts`, and `src/stash.ts`: it reads `<state>/trust/` for a request naming the pane, pauses the step's budget while one is there, and fails after 10 minutes of waiting on trust with "No trust decision for <folder> within 10 minutes" (D6), which closes what the opening created as any failed opening does (the waiting pi goes with it; nothing was typed into it).
Towers and the opener run in sessions that are not the server; they read the same directory, which is why the channel is files.

The deploy panel gets a step `trust` that the server inserts only when it happens (`StepId` gains `"trust"`; `createDeploy` gains `insert(step, before)`): the opening goes `start`, then `trust` while its pane has a request, then `join`.
The step reads "Waiting for your OK to trust this folder" and holds the same three choices inline (the same route), since the person who opened it is looking at the panel; the alert queue does not open a second dialog for an opening's own request, and it stays in the queue for a paired device or another tab.
The page's 120 s give-up counts only time outside the `trust` step.

### No GUI running

No server, a `stopped` one, one on another Herdr, or one from a build without `trust: 1`: the handler answers `undecided` and pi shows its own prompt, unchanged.
An agent outside Herdr, in print or RPC mode, or with a saved decision, `--approve`, `--no-approve`, or `defaultProjectTrust` other than `ask`, never reaches the handler's relay either.

### Desk mode and the team profile

- Desk mode (`docs/specs/2026-10-26-desk-mode.md`) needs nothing more: the desk window is this computer's page on `127.0.0.1`, every pane on the desk stack runs the handler, and S9 hides nothing of this.
  The fallback line in the terminal stays, for the rare case the shell's GUI is down (the person can open the pane's terminal tile).
- The team profile writes the desk's agent-dir `settings.json`. Recommended (D7): leave `defaultProjectTrust` at `ask`, so the PM is asked in the GUI once per new folder and the **Trust** choice remembers it.
  `always` would load any cloned repository's extensions with no question; `never` would drop the team repositories' own `.agents/skills`.
  A shell or switchboard that wants to spare the question for repositories it cloned from the team's host can write `trust.json` for that clone itself; that is its spec's decision.

## Tests

Unit (`node --test`, fakes for the store, settings, `gui.json`, stdin, the clock, and the directory):

- The handler answers `undecided` without a write for: mode `print` or `rpc`, `hasUI` false, no TTY, a second runtime in the process, a saved decision for the folder or a parent, a store that throws, `defaultProjectTrust` `always` or `never`, no `gui.json`, `stopped`, no `trust: 1`, another `herdr`, a server that does not answer.
- With a GUI: the request file is written by rename with mode 600, has the fields above, and its digest matches; the three answers map to `{yes, remember: true}`, `{yes}`, `{no}`; the request and answer are removed and the result says `remote`.
- A key first: `undecided`, raw mode restored, stdin paused with no listener left, the request removed, an answer that came after it ignored, the result `terminal`.
- A server that stops answering for 15 s: `undecided`, result `gone`; one that answers again within 15 s keeps the wait.
- An answer with another digest, an unknown choice, or another id is ignored and the wait goes on.
- `found`: a fixture folder for each protected resource gives its group, and `hasTrustRequiringProjectResources` is true for it, which pins the list against pi's own; `.agents/skills` in an ancestor is found, `~/.agents/skills` is not; the caps and `more`; an unparsable `settings.json` is listed as unreadable.
- The server lists a request only for its own Herdr, a live PID, and a listed pane; removes one whose process is gone; groups two requests of one folder and digest; cleans text; adds `trust: 1` to `gui.json`.
- The route: answered from this computer's page and from a paired device, refused (403) from the remote listener without a paired device's session; CSRF and origin as every write; `busy` for a second answer; 409 for a stale digest; `accepted`, `stale`, `unknown` from the results; one answer writes the answer file of every request in the group.
- `waitPastTrust`: a pane with a request does not use the 60 s; the request going away resumes the budget; 10 minutes on trust fails with the message and the opening closes its tab.
- Deploy: the `trust` step appears only when a request appears, between `start` and `join`; the page's give-up does not fire during it.
- Page (pure render, as the existing GUI tests): the alert's title, folder, groups, three buttons; the deploy panel's inline choices; the HUD counts it; the reminder and sound kinds; the same answerable alert on a paired device.

Windows CI (`tests/platform.test.ts`): the request and answer by rename under a concurrent reader, `fs.watch` or the stat fallback sees an answer within 1 s, and the PID-only liveness check when `started` is absent.

## Acceptance

Run as `AGENTS.md` says: scratch workspaces in the default Herdr, servers started with `env -i`.
The fixture is a scratch repository with `.pi/settings.json` (one package source), `.pi/extensions/hello.ts` (sets a status line when it loads), and `.agents/skills/demo/SKILL.md`, in a folder with no saved decision.

macOS (the desk `spike/mac` kit with the packed release, and a plain Herdr):

1. **+ New base** on the fixture: the deploy panel shows the `trust` step with the folder, the package source, `hello.ts`, and `demo`; **Trust** → the member joins, `hello.ts`'s status shows, `trust.json` holds the folder.
2. Remove the saved decision; **Trust this time** → it loads, `trust.json` is unchanged, a second base there asks again.
3. **Don't trust** → the member joins, `hello.ts` does not load, `trust.json` is unchanged.
4. A key in the pane's terminal while the alert shows: the alert closes within 2 s as answered in the terminal, and pi's own prompt works with all five options; after a GUI answer pi's TUI takes the first typed key (no raw mode or stray key left).
5. `/boss gui stop` while a pi waits: within 17 s the terminal says the window is not running and shows pi's prompt.
6. A Herdr restart with three panes in the fixture (decided "this time" before): one alert lists three agents, one **Trust** starts all three.
7. A tower opened by a promotion in the fixture asks in the GUI and opens once answered; an answer after 3 minutes still opens the agent; no answer for 10 minutes fails the opening and closes its tab.
8. A paired phone answers the alert and the agent starts; a POST on the remote listener without a paired session gets 403.

Windows 11 VM (desk shell or `spike/win/start.ps1`): 1, 3, 4, 5, and 7, plus no console window appears and raw mode leaves the pane's input working.

## Rollout

One minor release, independent of the desk releases (it needs nothing from desk R2 to R4), built in this order on one branch:

1. `src/trust/found.ts` and `src/trust/ask.ts` (the handler, the request, the terminal side), registered in `src/index.ts` before the subagent return.
2. `src/trust/serve.ts` (listing, cleanup, `trust: 1`, the route in `src/control.ts`, the snapshot field).
3. `src/trust/wait.ts` and its four callers, the `trust` step in `src/deploy.ts` and `src/spawn.ts`.
4. The page: `gui/alerts.ts`, the dialog, `gui/deploy.ts`, messages.
5. `docs/how-it-works.md` (a **Project trust** section under the browser view, and the files under **What it writes**), the README's feature list.

The pi side relays only to a server with `trust: 1`, so panes on the new release under a server of an older build keep pi's prompt, and an older pane under a new server never writes a request.
Each step passes `npm run check` and `npm test`; the release passes the acceptance above on both platforms before straw-boss-desk's `stack.json` pin moves.
It touches dialog relays and a security decision, so it gets one fresh-context review before merge.

## Decisions

The author accepted every recommendation on 2026-10-26 except D3, where the alternative was chosen: paired devices answer too. D2's upstream issue is not opened.

| # | Decision | Recommendation |
|---|---|---|
| D1 | How a pi that has not joined reaches the GUI | Files in `<state>/trust/` (request, answer, result), not an HTTP call to the server and not intercom, which is not up until `session_start`. |
| D2 | What the terminal shows while the GUI asks | A three-line notice and "press any key to answer here", which hands over to pi's own prompt; pi's startup selector cannot be dismissed, so it is not shown at the same time. Not an own TUI copy of pi's selector, and no keys sent into the pane through Herdr. Optional and outward-facing, so the author's call: open an upstream pi issue asking the startup `select` to honor `opts.signal`, which would let both prompts show at once later. |
| D3 | Who may answer | **Decided: this computer's page and paired devices**, as for relayed confirms (the recommendation was this computer only); never a Straw Link peer. |
| D4 | The GUI's choices | Trust (remembered), Trust this time, Don't trust (this time only, so a misclick has nothing to undo and the next agent asks again). No parent-folder choice in the GUI; the terminal keeps it. |
| D5 | Subagents | Relayed too (the handler is registered before the subagent return): a pi-herdr-agents worker in a new worktree folder otherwise stalls unseen. |
| D6 | How long an opening waits on trust | 10 minutes of trust waiting, then the opening fails at the `trust` step and closes what it created; the decision itself has no timeout. |
| D7 | The team profile's `defaultProjectTrust` | Leave it at `ask`; the GUI asks once per new folder. |
| D8 | Several agents waiting on one folder | One alert per folder and digest; one answer answers them all. |
| D9 | The GUI goes away during a wait | Hand over to pi's prompt after 15 s with no answering server (a takeover takes about 6 s). |
| D10 | Session replacement into another folder | Out of this change: pi's own prompt. A later step can relay it through the running TUI's `select`, which takes a signal there. |
