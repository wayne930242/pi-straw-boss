# Controlling pi sessions from `/boss gui`

Status: Phase 1 implemented in 0.4.0 (routes, chat history, the overlay layer); Phases 2 to 4 proposed, 2026-10-17. Base:
pi-straw-boss 0.3.1 (`3b71b19`), pi 1.3.0, Herdr 0.9.4, pi-intercom 0.17.1.

## Intent

`/boss gui` today is a read-only, live map of the straw net. This round turns it
into a place to work from: open one workspace or one session, read its chat
history in a readable form, type to the session as if typing in its terminal,
and answer the extensions that stop and wait for the user (questions, documents,
commands), without leaving the browser.

The user's requests, quoted, and where each lands:

| # | Request | Phase |
|---|---|---|
| R1 | 「來規劃下一輪，可以從 gui 直接控制，並且盡量支持我們現有的功能（至少先支援我有用的 extension）」 | 2, 3 |
| R2 | 「show doc 這樣應該可以很厲害地提供前端優化？」: show `show_doc` HTML in the browser with full rendering and take form answers there | 3 |
| R3 | 「gui 要提供可以 focus on workspace 的模式，可以有動態 router？」: `/<token>/w/<workspace>/s/<session>`, deep links, back/forward, no reload | 1 |
| R4 | 「click 可以看到當前美化的聊天歷史，這應該可以先做」: click a unit, see its live, beautified chat; first | 1 |
| R5 | 「user 的一般 input 應該直接接 herdr 的 input，就像是 user 直接 input」 | 2 |

Principle carried over from the previous spec (U9): Straw Boss stays light. Phases
1 to 3 need **no code inside the controlled sessions**: everything is read from
files the sessions already write and from Herdr, and all input goes through
Herdr's own input path. An in-session bridge is Phase 4 and optional.

## Scope

- In: client-side routes (net, workspace, session); the session chat view fed by
  the session JSONL; the input composer and its Herdr calls; a pending-dialog
  panel with a live terminal mirror and key pad; structured answers for
  `ask_user`; `show_doc` HTML rendered in the browser; read-only panels for todo,
  subagents, monitors and loops, and goal; the server protocol, security,
  performance, budgets, tests, and the live check.
- Out: remote or non-loopback access, multiple machines, editing session files,
  streaming partial assistant text (needs Phase 4), a GUI for `/tree`, `/resume`,
  model or thinking changes beyond typing the slash command, quotas (see the
  inventory), and any change to other packages (proposed separately, marked
  "upstream").

## Reality anchor

Everything below was read in source or run on this machine on 2026-10-17.
"Live" rows were run in scratch Herdr workspaces `wCN` and `wCP` that this
planning session created and closed (pi PIDs 15642 and 71705, confirmed gone,
scratch session file and directory removed).

### Current pi-straw-boss

| Fact | Evidence |
|---|---|
| The server refuses anything that is not a GET with the right token and `Host: 127.0.0.1:<port>`. | `src/gui.ts:57-60`, `:79` |
| CSP is `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'`: no frames allowed today. | `src/gui.ts:17-22` |
| `/<token>` redirects to `/<token>/`; `events` is the only dynamic path; everything else is a file under `dist/gui`. | `src/gui.ts:80-91` |
| The page opens `new EventSource("events")` relative to its URL, and the bundle uses relative asset URLs (`./assets/…`, Vite `base: "./"`), so any deeper URL breaks both today. | `gui/main.ts:43`, `gui/vite.config.ts:9`, `dist/gui/index.html` |
| The stream sends the full net on connect and on change, `ping` every 15 s, `problem` on a read failure; it polls only while someone listens. | `src/gui.ts:38-74` |
| One server per machine, inside the pi process of the session that started it; `gui.json` (mode 600) holds pid, port, token, owner. | `src/gui.ts:112-163` |
| Subagents are linked to their launcher through pi-herdr-agents' artifacts directory; unit ids are `<session id>/<name>` today. | `src/dashboard.ts:76-106`, `src/net.ts:37` |
| The extension returns at once in a pi-herdr-agents worker (`PI_SUBAGENT_ID`). | `src/index.ts:51` |
| `herdrApi` resolves with no result, so it cannot be used for `pane.read` as is. | `src/herdr.ts:59-73` |
| Bundle today: JS 8.7 KB (3.7 KB gzip), CSS 10.5 KB (3.2 KB gzip). | `ls -l dist/gui/assets`, `gzip -c … \| wc -c` |

### pi session files

| Fact | Evidence |
|---|---|
| File: `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<session id>.jsonl`; line 1 is the header (`type: "session"`, `id`, `cwd`, `version: 3`); other entries carry `type`, `id`, `parentId`, `timestamp`. | pi `docs/session-format.md:11,49-70` |
| The file is created only once the session has a user or assistant message (opened `wx` with every entry so far), then each entry is one `appendFileSync` line. **Live**: the scratch file appeared at the first assistant message. | `dist/core/session-manager.js:794-813`; live |
| Loading an older version migrates and **rewrites the whole file** (`openSync(path, "w")`). | `session-manager.js:720-724,754-760` |
| On load the leaf is the **last entry in file order**; `branch()` moves the leaf only in memory, and the next append names the branch point as its `parentId`. | `session-manager.js:735-742,1155-1166` |
| Compaction: `firstKeptEntryId`; older entries stay in the file. `context_edit` changes only model context, "the target entry … remain[s] unchanged in raw history, UI". | `docs/session-format.md:123-147` |
| Partial (`"pending"`) assistant messages are never persisted: text appears in the file only at `message_end`. | `docs/message-types.md:145` |
| Message roles: `system`, `user`, `assistant` (text, thinking, toolCall blocks), `toolResult` (by `toolCallId`), `bashExecution`, `custom`; plus `custom_message` (`display` flag), `custom`, `compaction`, `branch_summary`, `model_change`, `thinking_level_change`, `session_info`, `label`, `usage`. | `docs/message-types.md:13-262`; `docs/session-format.md:62-207` |
| Sizes (sessions touched in the last 3 days): 683 files, median 632 KB, p90 2.4 MB, max 58 MB. | `find ~/.pi/agent/sessions -mtime -3 …` |
| The 54 MB session: 7454 entries, one branch, 36 compactions; toolResult 29.4 MB, compaction 11.8 MB, assistant 7.8 MB, custom_message 4.8 MB; longest line 1.5 MB. A full `readFileSync` + `JSON.parse` of every line takes 258 ms. | `scratch/gui-control-probes/profile.mjs` (gitignored) |
| An index pass that streams 1 MB chunks and regex-parses only the first 160 bytes of each line (`type`, `id`, `parentId` come first) took **24 ms** for the 54 MB file, at most 1 ms per chunk, 7 MB heap, 0 misses. | `scratch/gui-control-probes/index.mjs` (gitignored) |
| Reading the last 64 KB of each of the 15 live pi panes' session files and finding the last assistant text: 19 ms total. | `scratch/gui-control-probes/tail.mjs` (gitignored) |
| A subagent's session file is in its launch script, `PI_SUBAGENT_SESSION='<path>'`, so it is known after the pane is gone. | pi-herdr-agents `maestro/adapters/pi/launch.ts:917,1078`; `subagent-scripts/<name>-<id>.sh` |
| Herdr exposes each pi pane's current session file as `agent_session.value` (`herdr pane get/list`, `herdr agent list`). | `herdr pane get "$HERDR_PANE_ID"` |

### Herdr input (0.9.4)

| Fact | Evidence |
|---|---|
| `herdr agent prompt <TARGET> <TEXT> [--wait …]` "honors the pane's live bracketed-paste mode and sends text followed by encoded Enter as one ordered submission"; it rejects a `blocked` agent with `agent_blocked` before sending anything. | `herdr agent prompt --help`; `herdr --skill` (Start and coordinate an agent) |
| Socket methods include `agent.prompt {target, text, wait?}`, `pane.send_input {pane_id, text?, keys?}`, `pane.send_text`, `pane.send_keys`, `pane.read`, `agent.focus`, `events.subscribe`. | `herdr api schema --json` |
| **Live**: `agent prompt <pane id>` works for a named agent and for an **unnamed** pi pane started with `pane run`; on a pane with no agent it answers `agent_not_found`. | wCN, wCP |
| **Live** (byte capture with bracketed paste on): `pane send-text` writes the text raw, no paste markers (`b'line one\nline two'`); `pane.send_input {text, keys:["enter"]}` writes `ESC[200~text ESC[201~\r` in one write. | wCN, `scratch/gui-control-probes/capture.py` + `send.py` |
| **Live** key encodings: `enter` `\r`, `alt+enter` `ESC \r`, `shift+enter` `\r` (same as Enter), `esc` `ESC`, `ctrl+c` `\x03`, `ctrl+j` `\n`. | wCN |
| **Live** in pi: while it works, Enter (and `agent prompt`) queues a message shown as `Steering:`; `pane.send_input` with `alt+enter` queues `Follow-up:`. Multi-line text pasted with `send_input` lands in the editor as two lines without submitting. | wCN |
| **Live**: text sent while the terminal editor holds an unsent draft is **appended to the draft** and submitted with it (`draft line twoappended text` became one user message). | wCN, scratch session file |
| `pane read --source visible --format ansi` of a pi pane: about 15 ms per CLI call, about 9 KB. | 5 timed calls on `wBB:p17` (this session's own pane) |
| Agent status `blocked` comes from the Herdr pi integration, which counts `herdr:blocked` events from extensions; the label is sent with `pane.report_agent` but is not shown in `pane list` or `agent list`. | `~/.pi/agent/extensions/herdr-agent-state.ts:137,211-227`; `herdr agent list` fields |

### pi input semantics and settings

| Fact | Evidence |
|---|---|
| Enter submits; Shift+Enter or Ctrl+J inserts a newline. | pi `docs/keybindings.md:88-89` |
| While pi works, Enter sends a steering message (after the current turn's tool calls), Alt+Enter a follow-up (after the task), Alt+Up returns queued messages to the editor, Escape stops the task and **returns queued messages to the editor**. | `docs/usage.md:36-40`; `docs/keybindings.md:124,166-167` |
| Ctrl+C clears the editor the first time and **exits pi the second time**; Ctrl+D exits on an empty editor. | `docs/keybindings.md:125-126` |
| The user's settings: `steeringMode: "one-at-a-time"`, `tuiMode: "fullscreen"`, pi-open-tui frames the editor (so screen-scraping the draft is theme dependent). | `~/.pi/agent/settings.json`; `herdr pane read wBB:p1 --source visible` |
| An extension can read the draft (`ctx.ui.getEditorText()`) and send messages (`pi.sendMessage(…, {deliverAs: "steer" \| "followUp" \| "nextTurn"})`, `pi.sendUserMessage`). | pi `dist/core/extensions/types.d.ts:137,332-335,1260-1267` |

Extension facts are in the [inventory](#extension-inventory).

## Architecture

```text
browser page (one per tab)                    GUI server (inside one pi process, one per machine)
 ├─ GET  /<t>/…                    ───────────► static bundle; index.html with <base href> and CSRF meta injected
 ├─ GET  /<t>/events?watch=<key>   ◄─────────── SSE: net snapshot, ping, problem, + history/pending of the watched session
 ├─ GET  /<t>/api/…                ───────────► older history pages, one entry in full, doc files, terminal snapshot
 └─ POST /<t>/api/…                ───────────► input, keys, focus, answers  ──► Herdr socket (agent.prompt, pane.send_input, …)

data the server reads, never writes:
  pi-intercom listSessions()          live sessions, status (idle, thinking, tool:<name>), Herdr location
  herdr pane/workspace/agent lists    panes, sb_role tokens, agent_status (blocked = waiting), agent_session.value = session file
  <session>.jsonl                     chat history, pending tool calls, todo and goal state, show_doc paths
  pi-herdr-agents artifacts           subagents, their session files (launch scripts)
  ~/.pi/loops/loops-<session id>.json loops
  herdr pane read (visible, ansi)     terminal mirror, only while a mirror is open
```

The server reaches sessions it does not run in through these files and Herdr only.
That is why it works for every pi pane, subagents included, and needs nothing new
inside them.

### Session keys and the allow list

Routes and API calls name a session by its **key**: the pi session id (header
`id`, equal to the intercom session id per the previous spec's live check). Each
net read builds a registry `key → {file, paneId?, workspaceId, name, role}` from:

1. live intercom sessions → `herdrLocation.paneId` → the pane's `agent_session.value`;
2. towers (same path);
3. subagents → the child id → its pane's `agent_session.value`, or else
   `PI_SUBAGENT_SESSION` in `subagent-scripts/*-<child id>.sh`;
4. if D1 is accepted, every other pi pane of a workspace (`agent === "pi"` in
   `herdr pane list`).

The registry is the **allow list**: the server reads only session files in it,
only files a `show_doc` call in one of them named, and only loop files of keys in
it. Paths never come from the browser.

`Unit` gains `key: string` (route key) and `control: boolean` (a live pi pane the
server may type into). Subagent unit ids change from `<parent>/<name>` to the
child id, so a route to a subagent survives renames.

## Phase 1: focus routes and the chat history (read-only)

Ships first (R3, R4). No POST endpoint exists in this phase.

### Routes

| Route | View |
|---|---|
| `/<t>/` | The net map, as today. |
| `/<t>/w/<workspace id>` | One base, zoomed in on the map's grid, in the map's game language: its tower, every tab as a squad of unit tokens (the map's icons and animated state badges) with each unit's last assistant line, subagents tethered under their launcher, outposts, and (D1) the workspace's other pi panes as unaligned units "outside the net". Entering zooms out of the base's spot on the map (transform and opacity only). |
| `/<t>/w/<workspace id>/s/<key>` | One session: the chat as a comms log on the left, the unit's dossier in the side column (portrait with icon and state badge, role, state, model, context use, cwd, base, squad, launcher, dispatched subagents; Phase 3 panels). |

- History API router (`pushState`, `popstate`), no reload; links are real `<a href>`
  so middle-click and copy-link work. Workspace and session ids are
  `encodeURIComponent`ed. Clicking a base opens its workspace route; clicking a
  unit its session route; Escape or the breadcrumb goes up one level.
- The server answers any `GET /<t>/w/…` that is not a file with `index.html`,
  rewritten once at start to carry `<base href="/<t>/">` and
  `<meta name="sb-csrf" content="…">` (Phase 2), so relative assets and `events`
  resolve from any depth. `base-uri 'self'` is added to the CSP.
- A key that left the registry (the pane closed, or switched with `/new`,
  `/resume`, `/fork`) shows "this session is no longer live", keeps the history
  readable while the file is in the registry's 10-minute recent list (same window
  as finished subagents, `dashboard.ts:32`), and links the pane's new session when
  Herdr shows one.

### Server: the session reader (`src/history.ts`)

One reader per watched file, kept while a page watches it and in an LRU of 8
afterwards.

```text
index(file):  stream 1 MB chunks; per complete line record {type, id, parentId, role?, offset, length}
              from a regex on its first 200 bytes; JSON.parse only when the regex misses;
              yield to the event loop between chunks (setImmediate)
leaf:         the last entry in file order (pi's own load rule)
path:         leaf → root through parentId; the view is the path, oldest first
tail:         fs.watch(file) plus a 1 s stat poll while watched; on change read [offset, size),
              keep an incomplete last line in a buffer until its newline arrives
rewrite:      size < offset, a different inode, or a different header line → re-index and send reset
branch move:  a new entry whose parentId is not the current leaf → recompute the path; when the
              common ancestor is older than the oldest item the page holds, send reset
missing file: the pane's file does not exist until the first message: show "no messages yet" and
              poll for its creation every 2 s while watched
```

Only the index stays in memory. Item content is read from the file by offset for
the page being sent, so a 58 MB session costs about 7 MB of heap (measured) and
one short read per page.

### Item model (server → page)

| Source | Item | Shown |
|---|---|---|
| `message` user | `user {text, images}` | A right-aligned bubble; text with line breaks and autolinks, not markdown; images as a count with click-to-load. |
| `message` assistant | `assistant {text, thinking?, tools[], model, stop, error?}` | Markdown text. Thinking hidden behind "thought · N chars" (content fetched on click; redacted shows as redacted). Each tool call a collapsed card. `stop: error \| aborted \| length` shows a badge and the error. |
| `message` toolResult | `result {callId, isError, preview, bytes, images}` | Attached to its call card by `callId`; preview ≤ 2 KB, "show all" fetches the entry (≤ 1 MB, then a truncated notice). |
| `message` bashExecution | `bash {command, preview, exitCode}` | A shell card (`! command`). |
| `custom_message` with `display: true` | `notice {customType, preview}` | A slim card: `intercom_message` "message from X", `subagent_result` / `subagent_ping` linked to the child's session, `pi-loop-monitor` wake, `memory-context` collapsed, others by `customType`. `display: false` is hidden. |
| `compaction` | `divider {tokensBefore, summary preview}` | "Context compacted · N tokens summarized", summary collapsed. Older entries stay above it (D10). |
| `branch_summary` | `divider {summary}` | "Branch summary". |
| `model_change`, `thinking_level_change`, `session_info` | `meta` | One dim line. |
| `system`, `custom`, `usage`, `label`, `context_edit` | none | Hidden (custom entries feed Phase 3 panels). |

Tool cards show a one-line summary per tool: `bash` the first command line, `read`
/ `edit` / `write` the path, `subagent` the name and role with a link to the
child, `intercom` the peer and first line, `ask_user` the question, `show_doc` the
paths, `todo` the action and subject, `MonitorCreate` the description; others
`name(first argument)`.

### Stream additions

`GET /<t>/events?watch=<key>` keeps today's events and adds, for the watched key:

| Event | Data |
|---|---|
| `history` | `{key, reset, items, before, header}`: on connect and on reset the newest 150 items (`before` = cursor for older ones); afterwards only new items. |
| `pending` | `{key, call?}`: the open tool call that waits on the user (Phase 3), or none. |
| `cards` | On a workspace route (`watch=w:<id>`): each unit's last assistant line (64 KB tail read). |

A route change closes the EventSource and opens one with the new `watch`, so a
tab holds one connection (HTTP/1.1 allows six per origin, and several open tabs
would starve on separate streams). The net snapshot resent on reconnect is a few
KB. The watchdog and backoff in `gui/stream.ts` apply unchanged.

`GET /<t>/api/history/<key>?before=<entry id>&limit=150` returns older items;
`GET /<t>/api/entry/<key>/<entry id>` one item in full (thinking, full tool
result), capped at 1 MB.

### Page

- `gui/router.ts` (parse and format routes, `popstate`), `gui/chat.ts` (items into
  DOM, keyed by entry id like `render.ts`, tool results attached by `callId`),
  `gui/markdown.ts` (see below), `gui/views.ts` (workspace cards, rail).
- **Long histories**: at most 150 items arrive at once; scrolling to the top fetches
  the previous page; every item gets `content-visibility: auto` with a
  `contain-intrinsic-size`, so off-screen items cost no layout; more than 600
  mounted items drops the farthest page (refetched on scroll). The view sticks
  to the bottom while the user is at the bottom; otherwise a "N new" pill appears.
- **Markdown** (D8): a small renderer of its own that builds DOM nodes, never
  `innerHTML`: paragraphs, headings, lists, task lists, block quotes, fenced and
  inline code, emphasis, links (`http`, `https`, `mailto` only, `rel="noopener
  noreferrer"`, `target="_blank"`), tables, horizontal rules. Raw HTML is shown as
  text. No syntax highlighting.
- Live state at the bottom of the chat: "working · using bash" from the net
  snapshot (intercom status), "waiting on a question" when blocked. Text of a
  running reply appears when pi writes it, at `message_end`; streaming it needs
  Phase 4.
- The chat code and the markdown renderer load as a separate chunk on the first
  session route (`import()`), so the map loads as fast as today.

### Overlay layer: stacked dialogs and tiles

User direction, 2026-10-17: sessions that need attention pop up a panel to handle them, but a new one must never cover or steal focus from the panel the user is working in; documents such as show_doc open as tiled panels side by side instead.
Phase 1 builds the layer with read-only content; Phase 2 and 3 dialogs (ask_user, robot_hand, secret_drop, the terminal mirror) and show_doc documents plug into it.

**Dialogs** stack in one dock over the side column.

| Rule | Behavior |
|---|---|
| Arrival | A unit that turns `waiting` or `error` (a question or an error, rank 0), or after the first snapshot turns `done` (a plain state change, rank 1), raises an alert. An alert never opens a dialog and never moves focus: it joins the queue shown in the header (count, the faces of the first three units, the head's name and state). An alert for a unit whose dialog is open refreshes that dialog instead. |
| Queue order | Rank first, then the oldest arrival. A repeated arrival keeps its place. |
| Opening | Only the user opens a dialog: from the header alert (the head of the queue), or by clicking a unit that waits or failed (map, base, dossier; a modified click still follows the link). An opened dialog leaves the queue, goes on top, and takes focus; one already open comes to the top instead of opening twice. |
| Stack | The top dialog is in front; dialogs beneath peek out above it, smaller and fainter, and are `inert`. |
| Closing | Close (× or Escape) removes the top dialog. The dialog beneath comes back; with none beneath, the next queued question or error does (it was waiting behind the closed one). Plain state changes stay queued until the user opens them. **Later** puts the alert back in the queue and reveals nothing queued, so the user can always step out. |
| Escape | Closes the top dialog only. With no dialog open, it goes up one route level. |
| Focus | Each dialog remembers where focus was when it opened and returns it there on close (inside the dialog beneath, or the page element that opened the first); when that element is gone, focus moves into the dialog beneath. Dialogs are not modal: the page stays usable and nothing traps focus. |
| Stale | A queued alert whose unit no longer shows the state that raised it leaves the queue by itself. An open dialog is never closed under the user; it shows the unit's current state. |
| Phase 1 content | The unit (portrait, role, state, base), its last assistant line and the tool call it waits on (from the newest 12 history items), **Open comms** (the session route) and **Later**. |

**Tiles** sit beside the current view and share its width.

| Rule | Behavior |
|---|---|
| Opening | A document opens as a tile beside the view (comms log, base, or map), never over a dialog. A tile the user opens takes focus and becomes active; one that arrives on its own (a show_doc call in Phase 3) shows beside the view without taking focus or the active tab. The same document is not opened twice. |
| Room | Up to four tiles; past that the oldest closes. Each tile closes with its own ×; closing the active one activates its neighbour. |
| Narrow | When the width cannot hold the view and every tile side by side, the tiles become tabs within the tile area; below 900 px the tile area goes under the view. |
| Phase 1 content | Read-only. `npm run gui:dev` demonstrates it with a demo document (the demo show_doc card's **open beside**, and the toolbar's **doc arrives**). The live server serves no documents until Phase 3. |

The models are pure (`gui/overlay.ts` for the stack, `createTiles` in `gui/layer.ts`) and tested in `tests/overlay.test.ts`: arrival while a dialog is open queues instead of covering, close reveals the next in order, stale removal, Escape closes the top only, focus restore, tiles that arrive without focus, and the tile cap.
The layer's DOM is a chunk of its own, loaded on the first alert, dialog, or tile; only the alert spotting (`gui/alerts.ts`) is in the map's chunk.

## Phase 2: typing into a session (R5)

### Composer

At the bottom of a session view whose unit has `control: true`:

| Control | Sends | When |
|---|---|---|
| Send (Enter in the box; Shift+Enter adds a line) | the text, then Enter | always; pi takes it as a new prompt when idle, a steering message while working (verified) |
| Queue follow-up (Alt+Enter in the box) | the text, then Alt+Enter | only while the session works; otherwise the button is hidden |
| Stop | Escape | while working, after a confirm ("queued messages go back to the terminal editor") |

- Text is capped at 16 KB (checked in the page and the server) and sent as typed:
  a leading `/` runs a pi command and a leading `!` a shell command, exactly as in
  the terminal. Commands that end or replace the session (`/quit`, `/exit`,
  `/new`, `/resume`, `/fork`, `/reload`) ask for confirmation first (D5).
- After a send the box clears only when the server confirms Herdr accepted the
  input; the message then shows up in the history when pi writes it.
- Disabled, with the reason, when: the pane is gone or no longer runs pi; the
  session is blocked on a dialog (Phase 3 shows it); the pane is a subagent and D7
  says read-only; the stream is down.
- **Unsent terminal drafts** (D2): input lands after whatever is in the terminal
  editor and is submitted with it, exactly as typing would. The composer says so
  in its placeholder. Phase 4 can detect a draft exactly.

### Server: `src/control.ts`

`POST /<t>/api/sessions/<key>/input {text, as: "send" | "followUp"}`:

1. Guards (see [Security](#security)); resolve `key` in the registry; `herdr pane get
   <paneId>` and require `agent === "pi"` and `agent_session.value === file` (a
   reused pane id is refused).
2. `blocked` → 409 `{reason: "waiting on a dialog"}`; no input is sent.
3. `send`, or `followUp` while not `working`: socket `agent.prompt {target: paneId,
   text}` (bracketed paste and Enter in one write; Herdr itself refuses a blocked
   agent).
4. `followUp` while `working`: socket `pane.send_input {pane_id, text, keys:
   ["alt+enter"]}`.
5. One request in flight per session; a second gets 429. The reply is
   `{accepted: true}` or Herdr's error code.

`POST /<t>/api/sessions/<key>/keys {keys}` sends only keys from an allow list:
`esc`, `enter`, `up`, `down`, `left`, `right`, `tab`, `shift+tab`, `space`,
`backspace`, `pageup`, `pagedown`, `home`, `end`, `alt+up`, `alt+o`, `ctrl+g`, and
the digits `1`–`9`. Never `ctrl+c` (a second one exits pi) or `ctrl+d` (exits on
an empty editor).

`POST /<t>/api/sessions/<key>/focus` runs `agent.focus` on the pane: the terminal
comes forward for things that must be done there.

`herdr.ts` gains `herdrCall(method, params)` that returns `result` (today's
`herdrApi` drops it).

## Phase 3: extension support

### Extension inventory

From `~/.pi/agent/settings.json` (packages and versions installed today). Usage
counts are tool calls in two long sessions of this week (moldplan-center 54 MB,
weihung-agent-root), to rank the work.

| Package | Interactive or visual surface | Where the GUI reads it | Answer from the browser | Order |
|---|---|---|---|---|
| pi-herdr-agents (fork) | `subagent`, `subagent_resume`… (313 and 89 calls); results arrive as `subagent_result` / `subagent_ping` custom messages | net subagents (today); child session files via launch scripts | none needed; the child is a session route of its own (input per D7) | P1 |
| pi-intercom | `intercom` calls (52); `intercom_message` custom messages; `intercom_sent` entries | session file | none; replies are typed to the session | P1 |
| @juicesharp/rpiv-todo | `todo` (80, 18); TUI widget | last `rpiv-todo-state` custom entry on the branch, else the last `todo` tool result `details` (`state/replay.ts:19-60`, `tool/types.ts:22`) | read-only | 3a |
| pi-ask-user (third party, edlsh) | `ask_user` (36, 21): a `ctx.ui.custom` TUI dialog; emits `herdr:blocked` and `ask:answered` / `ask:cancelled` with the question and answer kind only (`index.ts:2462-2470,2640-2668`); no API to answer from outside | the pending `ask_user` call's arguments in the session file + Herdr `blocked` | keys (below) for one question; the terminal mirror for the rest; upstream API in Phase 4 | 3b |
| pi-robot-hand (user's) `robot_hand` | 14, 5 calls: `ctx.ui.select` of what to do with a command (`index.ts:106-131`); choices depend on the draft and the mode | the pending call's `command`, `kind`, `reason` | the mirror and key pad; Copy in the GUI copies through the browser clipboard; an event API in Phase 4 (user owns it) | 3b |
| pi-robot-hand `secret_drop` | 9 calls: masked TUI input, `herdr:blocked` "Waiting for secret input" (`secret-drop/index.ts:223`) | the pending call's `label` and `instructions` | **never**: terminal only (below) | 3b |
| pi-herdr-doc-review (user's) `show_doc` | 8 calls: text in nvim, HTML in Chawan (no JS, no images, about 80 columns); forms `action="cgi-bin:pi-answer"` (GET) delivered as a custom message, steered or next turn (`index.ts:1-21,300-308,350-358`) | `show_doc` calls' `paths` resolved against the header `cwd` | HTML rendered in a sandboxed frame; form answers typed into the session (D4) | 3c |
| pi-loop-monitor | `MonitorCreate`/`List`/`Stop` (70, 40, 12), `LoopCreate`…; `/monitors` overlay; wakes as `pi-loop-monitor` custom messages | loops: `~/.pi/loops/loops-<session id>.json` (`dist/runtime/scope.js:3-10`, README:53); monitors: tool calls and results on the branch (their live state is in memory only) | read-only; stopping one is typed (`MonitorStop` through the agent) or done in the terminal | 3d |
| @narumitw/pi-goal | goal mode; `goal-state` custom entries (`src/persistence.ts:8,71`, `runtime.ts:1173`) | last `goal-state` entry on the branch | read-only; `/goal …` is typed | 3d |
| pi-quotas (fork) | `/quotas`, footer status from provider APIs with the user's credentials | not readable from outside (in-process, credentials) | none; the mirror shows the footer. Later, Phase 4 | later |
| @pify/memory | `memory_*` tools; `memory-context` custom messages | session file | none | P1 (cards) |
| pi-codex-image-gen, pi-antigravity | generated images in tool results | session file (`ImageContent`) | none; thumbnails load on click | P1 (cards) |
| pi-web-access, pi-mcp-adapter, pi-lens, pi-code, aaaav, pi-herdr-roles | tools and custom messages only | session file | none | P1 (cards) |
| pi-claude-bridge, pi-antigravity (provider) | models | assistant `model` | none | P1 |
| pi-jev-compaction, pi-session-hoarder | compaction | `compaction` entries | none | P1 (dividers) |
| cc-safety-net | blocks commands; tool results say so | session file | none | P1 |
| pi-open-tui, pi-catppuccin, pi-auto-tab-name | TUI look; tab names | net (tab labels) | none | none |
| pi-phoenix-otel, @moyai/pi-session-hoarder | telemetry, storage | none | none | none |
| pi-straw-boss | itself | | | |

### Pending dialogs

A session is **waiting** when Herdr says `blocked`. The server names what it waits
on: the newest tool call on the path with no `toolResult` yet, if its tool is
`ask_user`, `robot_hand`, or `secret_drop`; otherwise "a dialog". It sends a
`pending` event; the session view shows a panel above the composer, the map and
workspace cards show the amber `?` as today.

**Terminal mirror and key pad** (generic, works for any dialog): while the panel is
open and the page visible, the server reads `pane.read {source: "visible", format:
"ansi"}` once a second (about 15 ms, 9 KB) and sends it as `mirror` on the stream;
the page draws it in a fixed monospace box (a small ANSI SGR to spans converter, no
cursor addressing needed since the snapshot is already laid out). Under it, a key
pad of the allowed keys and a one-line text field sent with `pane.send_input {text}`
(bracketed paste, no Enter). This answers robot_hand's select, multi-select and
batch `ask_user`, `/monitors`, confirmations, and anything else in a pi TUI.

**`ask_user`, structured** (pi-ask-user 0.16.x; other versions use the mirror):
the panel shows the context (markdown), the question, the options with
descriptions, and a text field when `allowFreeform` is not false. Mapping, from
`handleInput` (`index.ts:1051-1120`):

| Case | Keys sent |
|---|---|
| One question, single select, option *i* ≤ 9 | `"<i>"`, `enter` (a digit selects the *i*-th shown option, `:1083-1090`; Enter submits it, `:1097-1109`) |
| Free text with options | `"1"`, `up`, `enter`, then the text with `enter` (the free-text row is the last row, `:875-877`, so Up from row 0 wraps to it; Enter opens the editor) |
| Free text, no options | the text with `enter` (the dialog opens straight in the editor, `:1289-1294`) |
| Cancel | `esc` (it first clears a search filter if the user typed one in the terminal, `:1052-1055`) |
| Several questions, multi select, option > 9 | the mirror and key pad |

Before sending, the server checks that the pending call id the page answered is
still the open one and that the pane is still `blocked`; after sending it waits up
to 3 s for that call's `toolResult` and otherwise answers "sent; check the mirror".
The page always shows the mirror after an answer until the result arrives.

**`secret_drop` is terminal only.** While it is pending, the server refuses
`input` and every key except `esc`, and offers no mirror text field; the panel
shows the label and instructions with a **Focus terminal** button (`focus`
endpoint). The same refusal applies to text sent to any session whose pending call
is `secret_drop`, so a secret never passes through the browser, the server, or
Herdr input from the GUI.

### `show_doc` in the browser (R2)

- The session view lists the HTML documents its `show_doc` calls opened (paths
  from the call, resolved against the session header `cwd`, then `realpath`). A
  click opens one in a frame beside the chat or full width; the frame reloads
  when the file changes (same watcher as history, 1 s poll while shown).
- `GET /<t>/doc/<doc id>/<file>` serves the document, where `doc id` is a random id
  the server gave that path; other files resolve only inside the document's own
  directory and only with image, CSS, and font extensions. Text documents (`.md`
  and others) render with the markdown renderer.
- Headers on documents: `Content-Security-Policy: sandbox allow-forms
  allow-popups; default-src 'none'; img-src 'self' data:; style-src 'self'
  'unsafe-inline'; font-src 'self' data:; frame-ancestors 'self'`. No scripts run,
  as in Chawan (show_doc tells agents to write pages without JS), but CSS, images,
  and full width work. The sandbox gives the document an opaque origin, so it
  cannot call the API even though it is served from the same port.
- Forms: the server rewrites `action="cgi-bin:pi-answer"` to
  `answer?n=<nonce>` (relative to the document, method GET as show_doc requires).
  `GET /<t>/doc/<doc id>/answer?n=…&<fields>` checks the nonce and types the
  fields into the session as one message, `Form answers from <document>:` and one
  `- name: value` line per field, through `agent.prompt` (steering when the
  session works). A blocked session gets an error page instead. The frame shows
  "Sent to `<session>`" (D4).
- Chawan keeps opening as today; nothing changes in pi-herdr-doc-review in this
  round.

### Read-only panels (rail)

| Panel | Data |
|---|---|
| Todo | rpiv-todo state as above: tasks with status, active first. |
| Subagents | the launcher's children with state (today's linking) and links to their session routes. |
| Monitors and loops | loops from the loop file; monitors from `MonitorCreate`/`MonitorStop` calls and results on the branch, labelled "from history". |
| Goal | the last `goal-state` entry: objective and status. |
| Session | name, role, cwd, model and thinking (last change entries), context use (last assistant `usage`), file size. |

Panels read the session reader's index (custom entries are small) and re-read on
new entries of their type only.

## Phase 4 (optional): in-session bridge

What the files and Herdr cannot give: the exact terminal draft, streaming
assistant text, and answers that do not depend on key layouts. A bridge inside
each session can:

- register one intercom extension channel `straw-boss/gui` in every Herdr pi
  session, workers included (before the `PI_SUBAGENT_ID` return in
  `index.ts:51`), never owner-eligible except in the session running the server;
  requests and replies carry `to`/`from` session ids and go to audience
  `capable` (≤ 16 KiB each, previous spec's anchor table);
- answer `draft?` with `ctx.ui.getEditorText()`, so a send can stop and ask when
  the terminal holds a draft;
- forward `message_update` deltas at most 4 times a second for the watched session
  only, so replies stream;
- relay a dialog event contract (`ui:pending {id, kind, title, options}`, `ui:answer
  {id, value}`) that pi-robot-hand (the user's) can adopt and pi-ask-user can be
  asked to adopt upstream.

It is a separate decision because it puts code into every session and needs the
intercom broker for control.

## Security

Control means typing into the user's terminals, so every write is guarded.

| Threat | Guard |
|---|---|
| Another local page reads or drives the GUI | The 128-bit token in every path (existing); `Host` must be `127.0.0.1:<port>` (existing, also stops DNS rebinding). |
| Cross-site request forgery | POST only for writes (GET on `/api/*` mutating paths answers 405); `Origin` must be `http://127.0.0.1:<port>`; `Sec-Fetch-Site`, when present, must be `same-origin`; `Content-Type: application/json`; header `X-SB-CSRF` must equal a second random secret injected into `index.html`. The custom header forces a CORS preflight that the server never approves. |
| Clickjacking | `frame-ancestors 'none'` on the app; documents allow only `'self'`. |
| Agent-written HTML attacking the app | Documents are sandboxed without scripts and without same-origin; only files named by `show_doc`, and images, CSS, and fonts beside them, are served. The only GET that writes is the document answer, gated by a per-document nonce. |
| Arbitrary file reads | Paths come only from the registry and `show_doc` calls; `realpath` and directory containment checks as in today's static serving (`gui.ts:85-86`). |
| A reused pane id | Input requires the pane's current `agent_session.value` to be the session's file. |
| Exiting pi by accident | `ctrl+c` and `ctrl+d` are not sendable; session-ending slash commands need a confirm. |
| Secrets | `secret_drop` is terminal only (above). No request body or typed text is logged by the server. |
| Body abuse | Request bodies ≤ 64 KB; text ≤ 16 KB; one in-flight input per session. |

## Performance and size budgets

| Item | Budget | Basis |
|---|---|---|
| Index a 58 MB session file | ≤ 100 ms total, ≤ 5 ms per event-loop turn | 24 ms and 1 ms measured |
| First history paint after a click (150 items) | ≤ 300 ms for the largest file | index + one ranged read |
| Server heap per indexed session | ≤ 16 MB | 7 MB measured for 54 MB |
| New lines to the page | ≤ 1.5 s after pi writes them (watch event, 1 s poll fallback) | |
| Terminal mirror | 1 read per second, only while open and visible | 15 ms, 9 KB |
| Workspace cards | one 64 KB tail read per unit per change | 19 ms for 15 files |
| Page JS (map chunk) | ≤ 15 KB raw, ≤ 6 KB gzip | 8.7 / 3.7 KB today |
| Page JS (chat chunk incl. markdown, mirror, panels) | ≤ 35 KB raw, ≤ 12 KB gzip | |
| CSS | ≤ 22 KB raw, ≤ 6 KB gzip | 10.5 / 3.2 KB today |
| Mounted chat items | ≤ 600 | `content-visibility: auto` |
| Runtime dependencies | none | as today |

Measured after Phase 1 (0.4.0, `tests/imports.test.ts`): map chunk 14.1 KB (5.9 KB gzipped), lazy chunks together 24.1 KB (10.2 KB), stylesheet 21.9 KB (6.0 KB).
The stylesheet has under 0.1 KB of its gzip budget left, so Phases 2 and 3 (composer, mirror, panels) need a new CSS figure before they start.

Source budgets (lines): `src/history.ts` 250, `src/control.ts` 150, `src/gui.ts` +
`src/net.ts` 300 together (226 today), `src/docs.ts` (document serving) 120;
`gui/router.ts` 80, `gui/chat.ts` 250, `gui/markdown.ts` 180, `gui/composer.ts`
120, `gui/mirror.ts` 120, `gui/panels.ts` 150.

## Failure behavior

| Condition | Behavior |
|---|---|
| Session file missing (new session) | "No messages yet"; the reader waits for the file. |
| File rewritten or truncated | Re-index and `history` reset; the page keeps its scroll position near the same entry id when it is still on the path. |
| A line that does not parse | Skipped, counted in the rail ("1 unreadable entry"). |
| Herdr input fails | The composer keeps the text and shows Herdr's error code (`agent_blocked`, `agent_not_found`, timeout). A timeout is not retried by the page: Herdr's guide says a timeout does not prove the input was not delivered. |
| The pane changed sessions or closed | Input disabled with the reason; history stays readable from the registry's recent list. |
| The owner session of the server exits | As today, the page reconnects to the next server on the same URL; an in-flight input reports failure. |
| An unsupported pi-ask-user version | The structured panel is replaced by the mirror and key pad. |

## Test plan

Unit tests run with `node --test` against fakes, like today (`tests/fakes.ts`).

| File | Cases |
|---|---|
| `tests/history.test.ts` | Index equals a full parse on fixture files (header, compaction, branch summary, custom messages, a 1.5 MB line); the leaf is the last entry; path through a branch point; appends with a line split across two reads; truncation and rewrite → reset; a new entry on another branch → reset only when it reaches the held items; missing file then created; previews capped at 2 KB and full entries at 1 MB; a 50 MB synthetic file indexes within budget (skipped unless `PERF=1`). |
| `tests/items.test.ts` | Entry → item mapping for every row of the item table, tool results joined by `callId`, hidden kinds stay hidden, the pending-call rule. |
| `tests/gui.test.ts` (extend) | Deep routes return `index.html` with `<base href>` and the CSRF meta; `events?watch=` sends `history` then appends; the API refuses a key not in the registry; `/api/*` GET on a write path → 405. |
| `tests/control.test.ts` | With a fake Herdr socket: `send` → `agent.prompt` with the pane id; `followUp` while working → `pane.send_input` with `alt+enter`, while idle → `agent.prompt`; blocked → 409 and nothing sent; reused pane (file mismatch) → 409; key allow list refuses `ctrl+c` and `ctrl+d`; `secret_drop` pending refuses input and keys except `esc`; missing or wrong Origin, `Sec-Fetch-Site: cross-site`, missing CSRF header, wrong content type, body over 64 KB, second in-flight request. |
| `tests/docs.test.ts` | Only `show_doc`-named files are served, with the sandbox CSP; sibling images and CSS yes, `..` and other extensions no; form action rewritten; answer with a wrong nonce refused; answer typed as one message. |
| `tests/askuser.test.ts` | The key mapping table above, from fixture calls; unsupported shapes fall back to the mirror. |
| `tests/router.test.ts`, `tests/markdown.test.ts`, `tests/chat.test.ts` (page, pure functions) | Route parse and format with encoded ids; markdown never creates elements from raw HTML, only allowed link schemes, tables and fences; chat merge by entry id and `callId`, reset handling, 600-item cap. |

### Live check

Run from a pi session in this repository; every scratch object is created by the
check and closed by it, confirmed by id and PID.

1. `herdr workspace create --label psb-live-gui --cwd /tmp/psb-live-gui --no-focus`;
   start pi in its root pane with `herdr agent start psb-live --kind pi --pane
   <pane>` (normal extensions, so pi-ask-user, pi-robot-hand, pi-herdr-doc-review,
   rpiv-todo load); record the PID from `herdr pane process-info`.
2. In that pi, `/boss gui`; open the URL with `agent-browser --session psb-live`.
3. Deep link straight to `/<t>/w/<workspace>/s/<key>`; back and forward between the
   map, the workspace, and the session without a reload (check `performance.navigation`
   entries stay one).
4. Ask the scratch pi for a short reply and a `todo` and a `bash` call; the reply,
   the tool cards, and the todo panel appear within budget.
5. Type from the composer: a prompt (idle), a steering message while it works, a
   follow-up while it works; check the pane shows `Steering:` / `Follow-up:` and
   the session file records them in order. Multi-line text arrives as one message.
6. Make it call `ask_user` with three options and free text: answer an option from
   the panel, then free text in a second call; check the tool results.
7. Make it call `show_doc` on an HTML page with a CSS file, an image, and a
   `cgi-bin:pi-answer` form: the frame renders them; submit the form; the session
   receives "Form answers from …". Confirm in the browser console that the frame
   cannot `fetch` the API.
8. Make it call `secret_drop`: the panel offers only Focus terminal; a crafted POST
   with text is refused (curl with the right headers gets 409).
9. Security probes with curl: no Origin, wrong Origin, no CSRF header, GET on the
   input path, wrong Host: all refused.
10. Open the largest session file's unit (a real session, **read only**) and time
    the first paint; scroll to the top through older pages.
11. Clean up: `agent-browser --session psb-live close`, `/boss gui stop`, exit pi
    with Ctrl+D, `herdr workspace close <id>`, confirm the PID is gone and the
    workspace is not listed, remove the scratch session files the check created
    (one by one), and `rmdir` their directory.

## Open decisions for the user

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Which sessions the GUI shows and controls | (a) only the net: joined sessions, towers, subagents; (b) the map stays the net, and a workspace route also lists the workspace's other pi panes as "outside the net", viewable and controllable | **(b)**: control is per pane, and the sessions the user wants to reach are often not joined; the map keeps today's meaning. |
| D2 | Text sent while the terminal editor holds an unsent draft | (a) merge, as typing would, and say so in the composer; (b) Phase 4 bridge checks the draft first and asks | **(a)** now (it is literally "as if typed"); (b) comes with Phase 4. |
| D3 | Answering `ask_user` from the browser | (a) keys for one-question single select and free text, the mirror for the rest; (b) propose an answer API upstream to pi-ask-user and use it through the Phase 4 bridge | **(a)** in Phase 3, and open (b) upstream in parallel; (a) stays the fallback. |
| D4 | `show_doc` | (a) the GUI also renders show_doc HTML and types form answers into the session as a message (wakes an idle agent, unlike Chawan's next-turn delivery); (b) pi-herdr-doc-review gains a browser viewer mode and an inbox so answers keep its steer/next-turn delivery and Chawan can be skipped | **(a)** now; (b) as a pi-herdr-doc-review release if the user wants Chawan gone. Pages run no scripts in either. |
| D5 | Slash commands from the composer | (a) all, as typed; (b) all, with a confirm for `/quit`, `/exit`, `/new`, `/resume`, `/fork`, `/reload`; (c) none | **(b)**. |
| D6 | Where the server runs | (a) inside the pi session that started it, as today; (b) a detached daemon | **(a)**: chunked reads keep that session's TUI responsive (≤ 5 ms per turn); revisit if it stutters. |
| D7 | Typing into subagents | (a) allowed, with a note that the parent orchestrates the worker; (b) read-only | **Decided: allowed, directly, with no note and no routing through a coordinator** (user, 2026-10-17: a pi-herdr-agents subagent does not need to go through the coordinator). |
| D8 | Markdown | (a) a small renderer of its own, no dependency; (b) `marked` + `DOMPurify` (about 60 KB) | **(a)**, within the bundle budget. |
| D9 | Phase 4 bridge (code in every session) | (a) build it after Phase 3; (b) skip | Decide after Phase 3 is in use; it buys exact drafts, streaming text, and robust dialog answers. |
| D10 | History before a compaction | (a) shown, with a divider; (b) hidden behind "show earlier" | **(a)**; it is the user's record, and pages load lazily. |

## Tasks

Sequential in the main checkout; each task ends green (`npm run check && npm test`)
and committed before the next. No parallel writers: tasks share `gui.ts` and the
page.

### 1. Routes, SPA fallback, and session keys
- **Files/area:** `src/gui.ts`, `src/net.ts`, `src/dashboard.ts` (subagent ids and files), `gui/main.ts`, new `gui/router.ts`, `gui/index.html`, `gui/vite.config.ts` (chunking), tests.
- **Behavior:** deep routes serve `index.html` with `<base href>`; `Unit.key`, `Unit.control`; the registry (allow list); router with map, workspace, and session views (session view empty for now); `events?watch=`.
- **Constraints:** no POST yet; today's tests stay green; map bundle within budget.
- **Acceptance:** `tests/gui.test.ts`, `tests/router.test.ts`, `tests/net.test.ts` updated and passing; back/forward works in `npm run gui:dev`.
- **Depends on:** none.

### 2. Session reader and items
- **Files/area:** new `src/history.ts`, `tests/history.test.ts`, `tests/items.test.ts`, fixtures under `tests/fixtures/`.
- **Behavior:** index, tail, leaf and path, reset rules, item mapping, previews, `history` events, `/api/history` and `/api/entry`.
- **Constraints:** budgets above; read only registry files.
- **Acceptance:** tests pass; `PERF=1` run under budget on a synthetic 50 MB file.
- **Depends on:** task 1.

### 3. Chat view and workspace cards
- **Files/area:** `gui/chat.ts`, `gui/markdown.ts`, `gui/views.ts`, `gui/style.css`, page tests.
- **Behavior:** the item table rendered; tool cards; lazy older pages; 600-item cap; sticky bottom and "N new"; workspace cards with the last line; chat chunk loaded on demand.
- **Constraints:** no `innerHTML` with data; reduced motion honored; bundle budgets.
- **Acceptance:** page tests pass; demo fixture gains a session with every item kind for `npm run gui:dev`.
- **Depends on:** task 2. **Phase 1 ends here: release 0.4.0.**

### 4. Input
- **Files/area:** new `src/control.ts`, `src/herdr.ts` (`herdrCall`), `src/gui.ts` (POST routing and guards, CSRF meta), `gui/composer.ts`, `tests/control.test.ts`.
- **Behavior:** Phase 2 as specified.
- **Constraints:** key allow list; no logging of text.
- **Acceptance:** tests pass; live check steps 3, 5, and 9.
- **Depends on:** task 3. **Release 0.5.0.**

### 5. Pending dialogs, mirror, `secret_drop` guard, `ask_user`
- **Files/area:** `src/control.ts`, `src/history.ts` (pending call), `gui/mirror.ts`, `gui/panels.ts`, `tests/askuser.test.ts`.
- **Behavior:** `pending` and `mirror` events; key pad; structured `ask_user`; terminal-only `secret_drop`.
- **Acceptance:** tests pass; live check steps 6 and 8.
- **Depends on:** task 4.

### 6. `show_doc` in the browser and read-only panels
- **Files/area:** new `src/docs.ts`, `gui/panels.ts`, `tests/docs.test.ts`; README and `docs/how-it-works.md`.
- **Behavior:** documents, form answers, todo, subagents, monitors and loops, goal panels.
- **Acceptance:** tests pass; full live check. **Release 0.6.0.**
- **Depends on:** task 5.

### 7. (If D9 says so) Phase 4 bridge
- Separate spec once Phase 3 is in use.


## Decisions (user, 2026-10-17)

The focus views follow the map's game language (user: 「我們一開始的設計模式就是要對齊遊戲」): the workspace route is the base zoomed in, the session route a unit dossier and comms log, one HUD on every route. Attention panels stack without covering the active one (「dialog 要考慮堆疊…不能蓋過現在的 dialog」), and documents tile beside the view (「show doc 那邊，直接看成 tiled dialog，在旁邊並排」); the rules are in [Overlay layer](#overlay-layer-stacked-dialogs-and-tiles).

D1 (b), D2 merge, D3 keystrokes plus an upstream proposal, D4 the GUI renders show_doc, D5 allowed with confirms, D6 server stays in the session, D8 own renderer, D9 later, D10 shown with a divider: all as recommended. D7: a pi-herdr-agents subagent is typed into directly, like any session; no note and no routing through its parent or a coordinator.
