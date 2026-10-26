# The sb server: a light Straw Boss backend and a tower that wakes

Status: design, not built. The boss decided every open question on 2026-10-26 (**Decisions**), and the review of straw-boss-desk's
owner of the same day is applied (**Review record**).
Base: pi-straw-boss 0.43.2 (`main` at `ce55ec4`, Straw Link steps 1 to 5b merged), pi 1.4.0, Herdr 0.9.5, pi-intercom 0.17.1.
Rebases: Straw Link build steps 6 to 8 ([2026-10-25-straw-link.md](2026-10-25-straw-link.md), **Build order**) and desk mode R2 to R4
([2026-10-26-desk-mode.md](2026-10-26-desk-mode.md), **Rollout**), both paused until this lands.

## Intent

Today the tower is a pi session that runs for as long as its tab stays open, and two machine-wide duties live in whatever pi session
holds them at the time: the GUI server (`src/host.ts`, handed between sessions by `gui.json` and survivor adoption) and the Straw Link
holder (`src/link/election.ts`, handed between sessions by `holder.json`). The boss wants:

- "塔台不常駐，但 pi sb server 需要多一個塔台服務，收到訊號不管是接收還是送出再來叫醒，讓 gui 的結構因此不被破壞，pi cli 啟動的時候就顯示運作、一般常駐":
  the tower is not resident. A tower service in the sb server wakes it on a signal, and the GUI shows it running from the moment pi starts.
- Each wake is a new pi session, "但起來的時候要拿到精簡的簡易脈絡，包括有哪些 main agent 是他主管，以及他的工作和使用的工具".
- "做完就關閉": the session exits when its work is done.
- "放在現有的位置": the woken tower opens as a pane in the existing tower tab. The map's structure stays the same.
- "讓 gui server 不只是 gui server，而是有一個輕量 sb 後端，讓 gui 接這個後端": one light backend process owns the tower service, the link
  holder, the net state, and the GUI.
- The member and main distinction stays.

This spec calls that process the **sb server**. It is one Node process per machine, it is not a pi session, and it runs from the
installed pi-straw-boss package.

## Scope

- In: the sb server's process model and lifecycle; what moves out of pi sessions; the tower service, its wake triggers, queue, wake
  protocol, brief, done and handoff; how tower tools reach the server; what changes in Remote turns; unattended devices; the GUI's
  tower states; `gui.json` and its successor; desk mode's changed seams; build steps; tests.
- Out: a remote MCP server, Phase 2 tailnet direct, the relay (unchanged), the switchboard, Linux as a desk platform, any change to
  members, mains, promotion, the guard's rules, or sidecars beyond the endpoint they call to open a tower.

## Terms

- **sb server**: the backend process (`src/server/`). One per state directory, bound to one Herdr socket.
- **Tower service**: the server's part that stands in for a workspace's tower: its intercom identity, its tab, its tokens, its queue,
  and its runs.
- **Tower identity**: the intercom session the server registers for one workspace's tower, id `sb-tower-<workspace id in lowercase>`,
  name `tower · <workspace label>`, Herdr pane = the tower tab's standing pane. The workspace token `tower` names it.
- **Standing pane**: the tower tab's one permanent pane. It sits at a shell prompt while no run is live.
- **Run**: one pi session the tower service starts. A **local run** works the workspace's local events in the standing pane. An **ally
  run** works the messages of one Straw Link device, in a pane of its own split into the tower tab.
- **Event**: one item the tower service queued for a run: an intercom message to the tower identity, a Straw Link `tower` envelope, a
  boss message from the GUI, or a notice the server raises (**Wake triggers**).
- **Brief**: the short context a run gets at its start (**The brief**).
- **Handoff note**: what a run leaves for the next run of the same kind (`tower_done`).

## Reality anchor

What the design rests on, read from the code and from pi-intercom 0.17.1 on 2026-10-26:

- The GUI server runs inside a pi session (`createHost`, `src/host.ts:22`). Every interactive session looks at `gui.json` every 2 s and
  adopts a server whose owner died (`adopt`, `src/host.ts:106`). `gui.json` is a documented contract for straw-boss-desk
  (how-it-works, **`gui.json` is a contract**), written by rename since desk R1.
- The link holder is elected among joined sessions and towers (`LinkElection`, `src/link/election.ts`; `outranks` prefers a newer build,
  then a tower). Towers reach it over the intercom extension channel `straw-boss/link` in 16 KiB chunks (`src/link/wire.ts`).
- A link delivery waits until the tower is idle and goes in as a `straw-link` custom message with `triggerTurn` (`pump`,
  `src/link/runtime.ts:209`). A run is a remote turn from that message until `agent_settled` (`src/link/turn.ts`), and later local runs hide
  older peer text (`hideOldRemote`, `src/link/turn.ts:79`, used at `src/link/hooks.ts:89`).
- A tower is started with `herdr agent start <name> --kind pi --pane <pane>` (`startPi`, `src/herdr.ts:197`). This needs the pane at a
  shell prompt: it answers `agent_pane_busy` otherwise. When pi exits, the pane returns to its shell.
- The opener remembers each sender and request only for the life of the tower session (`seen`, `src/opener.ts:49`).
- The tower prompt says "answer with intercom send" (`prompts/tower.md:3`). Every Straw Boss message carries a code-written header whose
  `id=` is the sender's own intercom id (`stamp`, `src/header.ts`; `selfParty`, `src/reach.ts`), so a reply goes to that id.
- The digest is read into the tower's system prompt under `Since your last run:` at the start of each run (`src/session.ts:149`).
- The guard keeps mains only while the workspace's `tower` token names a live intercom session (`src/guard.ts:48`). With no live tower,
  mains are demoted after 15 s.
- pi-intercom:
  - `PI_INTERCOM_STABLE_ID` gives a pi a fixed intercom id (`index.ts:565`).
  - A live process that holds an id keeps it, and a second registration of that id is refused with `SESSION_HELD` (`broker/broker.ts:529`).
  - A message to a disconnected id is queued for 24 h, but not a blocking ask (`broker/broker.ts:44`, `:853`, `:874`).
  - The broker never sends a message again by itself. To a receiver that registered `acknowledgesReceipts`, a live delivery waits up
    to 5 s for the receipt (`RECEIPT_TIMEOUT_MS`, `broker/broker.ts:49`; `completeSocketDelivery`, `:1155`). A receiver that
    disconnects first, or does not answer in time, makes the broker answer the sender `delivery_failed` with `delivery: "unknown"`,
    `retryable: true`, `outcomeKnown: false` (`failPendingReceipt`, `:1193`; `settlePendingReceiptsForSocket`, `:1205`, called on
    socket close at `:391`). The message is not put in the mailbox. A retry under the same message id is accepted and delivered again
    (`replayOrReject`, `:1219`, "a retry of an unconfirmed delivery is safe", `:1234`).
  - Mail queued for a disconnected id is written to the session when it registers and marked `socket_delivered` at once, with no
    receipt wait (`flushMailboxForSession`, `broker/broker.ts:1281`, `:1337`).
  - pi-intercom's outbox (the path Straw Boss sends by) uses the request id as the message id (`index.ts:1236`), refuses a request id
    already used in the same runtime (`index.ts:1154`), and reports an unconfirmed delivery as `failed`, code `delivery_failed`
    (`index.ts:1250`).
  - A registration may carry `herdrPaneId`, and the broker resolves it to a Herdr location (`broker/broker.ts:560`, `:702`).
  - `PI_INTERCOM_SCOPE_ID` splits sessions, channels, and broadcasts into separate scopes (`config.ts:23`, `broker/broker.ts:189`).
- A process that is not pi already runs Straw Boss's net modules: the net sidecar's headless kit gives them an intercom channel and
  outbox over a raw `IntercomClient`, and starts the broker when none runs (`createHeadlessKit`, `src/agent/kit.ts`; `intercomClient`,
  `src/agent/sidecar.ts`). It strips inherited `PI_INTERCOM_*`, `PI_SUBAGENT_*`, and `STRAW_BOSS_ROLE` first.
- `assertSettingsSafe` (`src/trust/settings.ts`, branch `fix/settings-precheck`, in review) runs before `startPi` in `spawn.ts`,
  `opener.ts`, `towertab.ts`, and `stash.ts` `popBase`, so pi never starts in a folder whose `.pi/settings.json` it would choke on.

## Design in one page

```text
pi session (any)           sb server (one per machine)                                   tower tab of workspace W
 ├ joins tab net ──────────┐ ├ GUI server (gui.ts, control.ts, hub, trust, spawn, closer)   ┌ standing pane: shell prompt
 ├ board_set               │ ├ link holder (relay streams, inbox, outbox, boards, admin)    │   └ local run: pi (one at a time)
 ├ call_tower ── intercom ─┼►├ tower service W: identity sb-tower-w ── queue ── wake ───────►│
 ├ openTower ─── socket ───┼►│    tokens, head watch, digest, opener ledger, close-main     └ ally pane: pi (one ally run)
 └ bridge (dialogs) ─ intercom ─► hub                                                          ▲
                                │                         tower tools ◄── socket (run token) ─┘
relay ── SSE ─► link holder ── ally message ── tower service W ── ally run
```

- The server registers the tower identity, so the workspace keeps a live tower at all times. The guard, `tower_list`, the dashboard,
  the sidebar, and the GUI work as before: they all find the tower by the `tower` token.
- Whatever reaches the tower identity, and every Straw Link message for the workspace, becomes an event. An event wakes a run. A run
  starts with the brief, gets its events as messages, does its work through tower tools that call the server, calls `tower_done` with a
  handoff note, and exits. The standing pane returns to its shell.
- Everything a run sends leaves under the tower identity, so replies come back to the server even after the run has exited.
- An ally message never enters a local run. It gets an ally run of its own, at its sender's trust level, from its first message to its
  exit.

## Process model and lifecycle

### One per machine

- One sb server per state directory (`$PI_CODING_AGENT_DIR/straw-boss`, else `~/.pi/agent/straw-boss`). It serves the Herdr server whose
  socket it was started for (`herdrSocket`, `src/endpoint.ts`). A pi on another Herdr (a scratch or named session) neither starts it nor
  uses it, as with the GUI today.
- `server.lock` makes check-and-start atomic, with the rules of `gui.lock`: taken over after 10 s, one looker at a time through
  `server.lock.stale`.
- `server.json` (mode 600, written by rename) records:
  - `pid` and `started` (process start time, through `startOf`), `version`, `herdr`, and `mode` (`detached` or `serve`);
  - `desk` (whether the server runs with `STRAW_BOSS_DESK=1`);
  - `gui: { port, token, stopped }`;
  - `stopped` (set only by a stop on purpose) and `restarting: { since, reason }` (set while a restart is under way, **Restarts and
    upgrades**);
  - `socket` (the control socket's path or pipe name), `secret` (the connection secret, **The control socket**), and `intercomId` (the
    server's own intercom session, `sb-server-<8 hex>`).
- A server counts as live when its PID is alive, started at the recorded time, and answers `hello` on the control socket within 2 s.
  The sidecar uses the same rule (`src/agent/claim.ts`): a PID alone is not enough.

### The control socket

- macOS and Linux: a Unix socket `server.sock` in the state directory (700), mode 600.
- Windows: a named pipe `\\.\pipe\sb-<16 random hex>`. Node's `net` creates it with the default DACL, which lets other local accounts
  connect, and pipe names can be listed, so neither the name nor a file mode protects it. The Unix socket's mode-600 argument does not
  carry over.
- So every connection, on every platform, starts with `hello { secret }`. `secret` is 32 random bytes in hex, made new at each server
  start and written to `server.json`. The server compares it in constant time and closes a connection whose first frame is not a
  matching `hello`, with no answer (logged at most once a minute). A run reconnecting after a restart reads the new secret from
  `server.json`.
- The secret is only as private as `server.json`. On Windows the server sets the state directory's ACL to the user alone before it
  writes the secret: `icacls <dir> /inheritance:r /grant:r *<user SID>:(OI)(CI)F`, run with `execFile` and no shell, then read back with
  `icacls <dir>`. If either fails, the server refuses to start (exit 3, with the reason). macOS and Linux keep the 700 directory and 600
  files they have today.
- Run tokens (**The wake protocol**) are checked on top of the secret, for requests a run makes.
- The net sidecar's Windows pipe (how-it-works, **From Claude Code or Codex**) has the same gap today. It is out of scope here and is
  recorded as a finding for the sidecar, to be fixed with the same `hello` secret.

### Where the command lives

- The command is `<agent dir>/npm/node_modules/pi-straw-boss/src/server/cli.mjs`, where `<agent dir>` is `$PI_CODING_AGENT_DIR`, else
  `~/.pi/agent` (`%USERPROFILE%\.pi\agent` on Windows). That is where `pi install npm:pi-straw-boss` puts the package, so a shell that
  installs pi-straw-boss into its own agent directory knows the path without asking anything.
- `cli.mjs` is plain JavaScript and runs under plain `node` 22 or newer (straw-boss-desk pins Node 22). It loads the TypeScript through
  `tsx`, which becomes a runtime dependency of pi-straw-boss (`^4`). `cli.mjs` resolves it from the package itself
  (`createRequire(import.meta.url).resolve("tsx/esm/api")`) and calls its `register()`. It does not look beside pi-intercom. If `tsx`
  cannot be found, it exits 3 and names the path it looked from.
- Why a dependency: pi-straw-boss has no runtime dependency today, and the sidecar finds `tsx` beside pi-intercom
  (`src/agent/paths.ts:106`). That works only because npm happens to hoist pi-intercom's `tsx` there, which is not a contract. The
  detached start from pi sessions uses the same `cli.mjs`.

### Starting

- **From pi.** Every interactive pi session in Herdr that is not a subagent and not a run checks at `session_start`, and then every 2 s
  (the adoption cadence it already has), whether a live server runs for its Herdr. If none runs and `server.json` is not `stopped`, it
  takes `server.lock` and starts one: `node <cli.mjs> run --detached`, spawned with `{ detached: true, stdio: "ignore", windowsHide:
  true }` and unref'd, so Windows opens no console window. The process gets a constructed environment: the session's environment minus
  `PI_INTERCOM_*`, `PI_SUBAGENT_*`, `STRAW_BOSS_ROLE`, and `HERDR_PANE_ID`/`HERDR_TAB_ID`/`HERDR_WORKSPACE_ID`. The session returns at
  once and says nothing unless the start fails. Of several sessions, the lock lets one start the server. This is what "pi cli 啟動的時候就
  顯示運作" means here: the first pi of the day brings the server up, and the GUI's towers show as standing within a few seconds.
- **`cli.mjs up`** makes sure a live server runs and prints one JSON line (**Desk mode**, `up`'s output). Step by step:
  - **None runs:** it starts one detached, as a pi session would, and waits for `hello`.
  - **Stopped on purpose:** it clears `stopped` in `server.json` and in `gui.json` (and `gui.stopped`) under the lock, then starts one.
  - **Live, GUI stopped:** it starts the GUI listener again on the recorded port and token.
  - **Live on an older version than the package `up` runs from:** it asks for `upgrade` and starts the new server from its own package.
  - **Live on a newer version:** it leaves the server alone and warns `server_newer` (exit 0), or, with `--exact`, exits 1 at step
    `version`. It never downgrades.
  - **Desk mismatch:** `up` with `STRAW_BOSS_DESK=1` in its environment, against a live server whose `desk` is false, restarts that server
    with the switch (**Restarts and upgrades**). `up` without the switch, against a desk server, leaves it as it is and warns
    `desk_on`. Desk mode is read from the environment at start only; there is no control call that changes it.
  - The JSON's `server` field says which of `found`, `started`, `restarted`, or `upgraded` happened.
- **`cli.mjs serve`** runs in the foreground with `mode: serve`, for launchd and systemd (unattended devices). It also clears `stopped`.
  - **None runs:** it runs.
  - **A live `detached` server:** `serve` takes it over. It asks that server to hand over by the restart path (same port and token,
    ≤ 10 s) and then runs in the foreground. Exiting instead would make launchd's `KeepAlive` or systemd's `Restart=` start it again and
    again, while the server that actually runs is one no supervisor watches.
  - **A live `serve` server:** two supervisors are a configuration error. `serve` prints that server's record and exits 4.
- straw-boss-desk uses `up` only (a detached server, quit with `cli.mjs stop`); `serve` is for supervisors.
- **From a pi session:** `/boss server` (status), `/boss server stop`, and `/boss server restart`. `cli.mjs status|stop|restart` do the
  same from a shell; the docs call it `sb`.

### Living

- The server keeps one `events.subscribe` connection to Herdr and re-reads when a new Herdr server takes over the socket. It republishes
  its tokens then, as sessions do today ("A new Herdr server").
- When its Herdr server stops answering, a `detached` server waits and exits after 60 s without one. A `serve` server waits for as long as
  its supervisor runs it. Otherwise it stays up: it does not exit when the last pi session ends ("一般常駐").
- It starts the pi-intercom broker when none runs and reconnects with the sidecar's backoff (1, 2, 5, 10, then 30 s). While it is
  disconnected, its tower identities are not live. That is the only time the guard's 15 s grace matters (**Risks**).

### Stopping

- `stop` is on purpose. It warns first, because every workspace then loses its live tower and mains are demoted 15 s later.
  `/boss server stop` asks to confirm with that text; `cli.mjs stop` prints it on stderr and goes on, since a shell quitting has nobody
  to ask.
- Then it writes `stopped` under the lock, ends the runs' claims (a live run gets its `quit`, **The wake protocol**), takes the remote
  serve entry down, deregisters the tower identities, and exits.
- No session starts it again on its own. These do: `/boss server`, `/boss gui`, `/boss tower`, a promotion that opens a tower, and
  `cli.mjs up` or `serve`, which clear `stopped`. straw-boss-desk stops with `cli.mjs stop` when it quits, and its next launch's `up`
  brings the server back.
- A crash, a kill, or a reboot is not a stop. The next session look, or the supervisor, starts it again on the recorded GUI port and
  token, so open pages reconnect.

### Restarts and upgrades

- Every restart goes the same way: `restart`, `upgrade`, `up`'s desk restart, and `serve` taking over a detached server.
  1. The old server writes `restarting: { since, reason }` to `server.json`.
  2. It stops accepting control requests (answering `restarting`), finishes the writes in flight, flushes the queue and run records,
     closes the GUI listeners, releases its intercom ids and `server.lock`, and exits within 10 s.
  3. The new server binds the recorded local and remote ports with the same token and CSRF secret. It retries for up to 5 s while the
     old ports are let go, then clears `restarting`.
- So the URL does not change: a page or a desk webview only reconnects its stream, and a page from another build reloads itself at the
  same URL. The URL changes only when another process has taken the port meanwhile (Moved, **States for a shell**). That is the one case
  in which a shell reads the record again.
- Upgrades:
  - A pi session on a newer pi-straw-boss than `server.json`'s `version` asks the live server to `upgrade`, then starts the new server
    from its own package.
  - `up` from a newer package does the same.
  - A session or an `up` on an older package never downgrades the server.
- Runs are separate pi processes, and a server restart does not end them. A run whose socket closes reconnects every second for 30 s
  with its pane and PID. It reads the new secret from `server.json`. The new server knows it from `tower/<ws>/runs/<id>.json` and takes
  it back (**Crash and timeout**).
- A session older than the server does nothing. A session from before this change does not know the server. It sees `gui.json` owned by
  a live process and leaves the GUI alone. It sees `holder.json` held by a newer build and does not take it. If it opens a resident
  tower, the pi in that tab runs the installed (new) code and hands over (**Migration from resident towers**).

## What moves out of pi sessions

| Duty | Today | With the sb server |
|---|---|---|
| GUI server: `gui.ts`, `control.ts`, the dialog hub, trust serve, spawn and deploys, closer, mirrors, documents, uploads, remote access and pairing | The session that hosts it (`host.ts`), adopted by survivors | The server. The hub owns `straw-boss/gui/<hash of the server's intercom id>` with no local bridge. Bridges in sessions do not change. |
| Link holder: relay streams, inbox, outbox, presence, boards, admin, `link_request` checks, confirms | The elected session (`election.ts`, `runtime.ts`) | The server, the only candidate. It still writes `holder.json` and takes `holder.lock`, so an old build sees a live holder of a newer version and leaves it. |
| Requests from sessions to the holder (`send`, `list`, `board-read`, `request-*`, `gui`) | Channel `straw-boss/link`, chunked | Control socket, one JSON request per connection. The channel keeps one use: the server's offers of an ally's reply to the main that asked for it (**Replies for a main**). |
| Tower marks: workspace token `tower`, pane token `sb_role=tower` (4-minute refresh, 10-minute TTL), the tower tab first | The tower session (`presence.ts`) | The tower service, for each workspace that has one |
| Head watch, digest line on a head change | Each tower (`headwatch.ts`) | The server, on one events connection |
| Reading and clearing the digest | The tower at each run (`session.ts:149`) | The tower service, into the brief of each local run |
| The opener's ledger and limits | In memory for the tower's life (`opener.ts:49`) | Persisted per workspace (`tower/<ws>/opened.json`, 24 h) |
| `close-main` on `straw-boss/control` | The tower session registers the channel | Each tower identity registers it, so the main's "sender is the tower token holder" check holds |
| Tower restore after a Herdr restart | `roles/<hash>.json` with role `tower` | `tower/<ws>/service.json`, by workspace id (kept by a restore) |
| Choosing the tower that gets a link message | The holder, by tower pane cwd | The server, by the standing pane's cwd (else the workspace's checkout path) inside the team's `project` |

The rest stays in sessions: joining, the tab channel and its election, the guard, promotion, `board_set`, `call_tower` and
`boss_broadcast` (the sending side), the dialog bridge and `intercept.ts`, orphan nudges, blocked dialogs, pane balance, stash, the
sidecars, the `link_request` tool (it asks the server), and the remote-turn hooks (they run inside ally runs).

## The tower service

### A workspace gets one

- `openTower` (`src/reach.ts`) no longer starts pi. It asks the server `ensure-tower {workspace}` over the control socket and gets the
  tower identity's id back. The rules for *when* a tower opens stay: a promotion, a member that dispatches, the two-member rule,
  `/boss tower`, `call_tower` from a main. A sidecar's `call-tower` asks the same endpoint.
- `ensure-tower` makes the tab the way `ensureTower` does today (reusing a marked or bare tower tab, moved first, labelled with the
  glyph). It creates the standing pane's shell with `STRAW_BOSS_ROLE=tower-run`, marks the pane `sb_role=tower`, registers the tower
  identity with `herdrPaneId` = the standing pane, registers `straw-boss/control` for it, and writes the workspace token `tower` and
  `service.json`. It starts no pi. It answers within about 2 s, against up to 60 s today, since no pi has to start.
- A sub workspace still has no tower. `ensure-tower` for one answers with its parent's tower, as today.

### A workspace loses one

- The boss closes the tower: the tower card's close button, `/boss close` aimed at the tower, or the tab closed in Herdr. The service then
  ends its runs, deregisters the identity, clears its tokens, writes `sb_tower_quit=<members it left>` as a quitting tower does today,
  deletes `service.json`, and keeps the queue for 24 h. A tower reopened in that time gets it, and the brief says how old each event is.
- A run that exits is not the tower quitting. Its pane returns to the shell, and the tab and the identity stay.

### State

`tower/<workspace id>/` in the state directory (mode 700, files 600, each written by rename):

- `service.json`: the identity id, the standing pane and tab, when it was created, and the next event sequence number.
- `queue/<seq>-<event id>.json`: one queued event (**Queueing**).
- `runs/<run id>.json`: kind (`local` or `ally`), the device and level for an ally run, pane, pi PID and start time, Herdr agent name,
  session file, started, ended, outcome (`done`, `timeout`, `crashed`, `quit`), and the event ids it took. The last 50 are kept.
- `notes.jsonl`: handoff notes, local ones and each device's ally ones apart, the last 10 of each.
- `opened.json`: the opener's ledger (sender, request hash, outcome, tab, main), 24 h.

## Wake triggers

An event wakes a run. Everything else is shown in the GUI or handled by the server alone.

| Source | Becomes | Run |
|---|---|---|
| An intercom message to a tower identity: `call_tower`, `tower_send` from another tower, a `boss_broadcast` with scope `towers`, a main's done report, a reply to something the tower sent, a plain `intercom send` | Event `intercom`, with the text as received (its code-written header included) and the broker's sender line | Local |
| A Straw Link `tower` envelope routed to this workspace (**Delivery**, Straw Link spec) | Event `link`, through the inbox as today | Ally (**Ally runs**) |
| The boss types into the tower from the GUI while no local run is live | Event `boss`, the text verbatim | Local, queued ahead of the rest |
| An outcome of something a run sent that arrives after that run ended: a relay refusal after "queued", an intercom delivery that failed, a main opened by the opener that failed to start, a `close-main` that timed out | Event `notice`, written by the server | Local |
| `tower_done({ wakeAfter })` asked for a follow-up, 5 to 240 minutes, one pending per workspace (D3) | Event `timer` | Local |

These do not wake a run:

- Presence and `board` envelopes (they never start a turn, as before).
- A `confirm-request` from an ally's gate at `forward`: it is the boss's to answer in the GUI's notices, as today. A `confirm-answer` goes
  to the ally run waiting for it.
- A join request, a roster mismatch, the relay unreachable: these are GUI notices for the boss.
- Herdr events and state changes of mains: the tower reads them in the brief when something else wakes it.
- An ally's `tower-reply` to a `tower_send` that named `for` (D4): it goes to the main that asked, with no run (**Replies for a main**).

**What "send" means (D2).** The boss's "不管是接收還是送出" means two things. First, the result of a send the tower made comes back
after its run ended: the `notice` row above, and replies, which arrive as `intercom` events. Second, the boss asks the tower to send
something: the `boss` row. A send on its own wakes nothing.

## Queueing and concurrency

- **One local run per workspace at a time.** Workspaces are independent, so two workspaces may each have a local run. The server runs at
  most `towerRuns` pi runs at once across the machine (default 4, `config.json`), and the rest wait in their queues.
- **Ally runs** go in an ally pane beside the local run, one ally run per workspace at a time (D6).
- **Ordering.** Within a workspace, events go in the order the server received them, except that `boss` events go first. For each
  local event the broker's message id is kept, and for each link event the envelope id.
- **Dedupe.** An intercom message id is taken once per sender, with a retry's `~r<n>` suffix removed (the broker already refuses a
  reused id with other content). An envelope
  id is taken once (the inbox and the sender's sequence mark already ensure this). A `notice` has an id derived from what it reports, so
  a retry does not double it.
- **Persistence.** The server registers each tower identity with `acknowledgesReceipts` and only after its queue store is open. It reads
  each message off the socket, writes it to `queue/` with an fsync, and only then sends the receipt `queued`. A link event stays in
  `link/inbox/` until a run takes it, as today. While the server is down, mail to a tower identity waits in the broker's mailbox (24 h).
  This holds because every Straw Boss message is a `send`, never a blocking `ask`. A sender using pi-intercom's `ask` to a tower
  identity that is down gets `E_TARGET_DISCONNECTED`, as for any session that is gone.
- **The broker never sends again by itself** (**Reality anchor**). Two gaps follow, and each is closed or bounded here:
  - *A live delivery whose receipt never came* (the server crashed or restarted between reading the message and its receipt): the
    broker tells the sender the outcome is unknown and drops the message. Straw Boss's sender (`send` in `src/reach.ts`, used by
    `call_tower`, `tower_send`, `boss_broadcast`, the opener's handoff, and the server's own sends) retries such a failure when the
    target is a tower identity (`sb-tower-*`). It waits until the identity is live again (up to 30 s, the restart budget), then sends
    again. pi-intercom's outbox refuses a request id it already used, so the retry goes under `<request id>~r<n>` (at most 3). The
    server takes a message once per sender and message id with the `~r<n>` suffix removed, so a message that was in fact queued before
    the crash is not taken twice. A plain `intercom send` from another agent is not retried by Straw Boss: pi-intercom tells that agent
    the delivery "could not be confirmed", and it decides.
  - *Mail flushed from the broker's mailbox when the identity registers*: the broker marks it delivered at once, with no receipt, so a
    crash while the server writes that batch loses it with nobody told. The server keeps the window small: the batch is the first
    thing it reads after registering, written before anything else is done. The gap itself is in pi-intercom, so B5 proposes an
    upstream change: a mailbox flush to an `acknowledgesReceipts` session waits for each receipt and puts unreceipted mail back in the
    mailbox when that session disconnects. Until that ships, it is a documented limit (**Risks**).
- **Coalescing.** A wake waits 1 s after the first event, so a burst starts one run with all of it.
- **Events while a local run is live** go to that run, at the next moment it is idle (`isIdle()` and no pending message, checked in the
  same tick, as `pump` does). Each one goes as one custom message `straw-tower` with `triggerTurn`, and the run reports it `taken` once it
  is in the session. An event offered but not taken returns to the head of the queue when the run ends.
- **Events while a run is closing** (after `tower_done` was accepted) wait for the next run, which starts 1 s after the pane is back at
  its shell.

## The wake protocol

1. **Start.** The server checks `towerRuns`. It runs `assertSettingsSafe([dir])` on the standing pane's cwd (else the workspace's
   checkout path) before every run, local and ally, and runs nothing when the check refuses: the events stay queued, the tower card shows
   the refusal as an error notice, and the next attempt comes with the next event, at most once a minute. Then it starts pi in the
   standing pane: `startPi(run, sleep, "tower-<ws>", pane, ["--name", "tower · <label>", ...towerModel])`, with `waitPastTrust` covering a
   project trust question as for any tower today. An ally run first splits the tower tab (`pane split`, no focus) and starts pi there
   under `ally-<ws>`. That pane closes when its pi exits.
2. **Claim.** Straw Boss in the new pi sees `STRAW_BOSS_ROLE=tower-run` (or a pane the server split for an ally run) and asks the server
   to `claim {pane, pid}` over the control socket. The server checks with `herdr pane process-info` that this PID is the pi in a pane it
   just started a run in, then answers with a run token (random, kept in memory only), the run's kind, its level, and the brief. Herdr's
   `agent start` takes no environment for an existing pane, so the claim goes by pane and PID instead.
   - A pi in a tower pane that the server did not start: if its session file already holds a run entry, it is a run that a Herdr
     restore resumed, so it quits at once with a notice ("a tower run is never resumed; the next event wakes a fresh one"). If not, the
     boss started pi there by hand. That becomes a local run with the brief and no events, and it ends on `tower_done` like any run.
3. **Run.** The run's Straw Boss is in run mode. It does not join a tab net, publish tokens, run the guard, look at the server, or hold
   a link role. Its bridge relays its dialogs as in any session. It registers the tower tools (**Tower tools**) and blocks
   pi-intercom's `intercom` tool, pointing to `tower_reply`. It puts the brief in its system prompt's role section, and sends the claimed
   events as `straw-tower` messages in order. The first one triggers the turn.
4. **Done.** The run calls `tower_done({ note, wakeAfter? })`. `note` is required, 1 to 1,200 characters, one item per line, and is
   cut and cleaned like a board entry. If the server has events offered to the run but not yet taken, or new ones queued for it, it
   refuses with "N events still for you" and offers them. Otherwise it records the note, marks the run `closing`, and answers. The run's
   extension then quits pi (`ctx.shutdown()` after the tool result is written). The standing pane is back at its shell, or the ally
   pane closes. The service is `standing` again, or wakes the next run 1 s later if events came in meanwhile.
5. **Handoff.** The note goes into the next run of the same kind: a local run's note to the workspace's next local run, an ally run's
   note to the next ally run of the same device. Nothing crosses between the two.

### Crash and timeout

- **Idle without done.** A run that settles idle with nothing pending and no `tower_done` gets one steer after 60 s: "call tower_done
  with your handoff note". After another 5 minutes idle the server ends it (`quit` over the socket) and writes the note
  `(ended without a note)`.
- **Too long.** A run older than 20 minutes gets a steer to wrap up and call `tower_done` within 2 minutes. After that it gets `quit`.
  The tower never waits on work: a main's result comes back as a new event. So a long run is a fault, and the cap keeps a stuck run from
  holding the queue.
- **Quit fails.** If pi has not exited 10 s after `quit`, the server sends Escape and `/quit` through Herdr, then SIGTERM to the PID read
  from `herdr pane process-info`, never one from a record alone.
- **Crash.** The pi exits without `tower_done`: its socket closes and Herdr reports the pane at its shell or the agent gone. Its offered
  events go back to the queue. Its taken events go back too, flagged `possibly handled by a run that crashed: check before acting` in the
  next brief, so delivery is at least once. The note is `(crashed)` with the last outcome.
- **Crash loop.** Three crashed or timed-out runs in 10 minutes stop the service's waking. The tower card shows an error notice with the
  last run's tail (20 lines of `herdr pane read`). The queue is kept. The next `boss` event, or **Retry** on the notice, wakes again.
- **Server restart during a run.** See **Upgrades**. A run that does not reconnect within 30 s is treated as crashed once the new server
  sees its PID gone, or as orphaned if it is still alive: it gets `quit`.
- `/new`, `/resume`, or `/fork` in a run end its claim: the server records outcome `quit`, and the next event wakes a fresh run. A
  `/reload` keeps the claim (same process, same pane).

## The brief

The brief is plain text in the run's role section. It is built by the server, never by a model, and has a hard cap: **6,000 characters**
for a local run and **4,000** for an ally run. Each section has its own cap, and a cut section says how much it left out.

Local run, in this order:

1. **Who and why** (≤ 300): `You are a run of the tower of workspace <label> (<id>); head tower: <label>. Woken <HH:MM> by: <n intercom,
   n boss, n notice, n timer>. Your identity for replies is sb-tower-<ws>; everything you send leaves under it.`
2. **Mains you supervise** (≤ 24 rows, each ≤ 200): per tab of the workspace, the main's name, short session id, state (`idle`,
   `working`, `waiting`, `commanding`), whether a tower opened it (and for whom), and its board `now` with its open item count. Members
   are counted per tab and not named. A tab with no main says so. These are the same data as `board_read`'s `local` and the dashboard.
3. **Open obligations** (≤ 10 rows): from the opener's ledger and the run records. Mains this tower opened that have not reported, mains
   that reported done and wait to be closed, sends that expect a reply and have none, and a `wakeAfter` that is due.
4. **Since your last run** (≤ 20 lines of 80): the digest, read from the `sbd_` tokens and cleared once the run has claimed the brief.
5. **Handoff note** (≤ 1,200): the last local run's note, with its age.
6. **Tools** (fixed text, about 900): one line per tower tool (**Tower tools**), ending with "Call tower_done with a handoff note when
   nothing is left for you."
7. **Flags**: events flagged by a crash, and the run cap (20 minutes).

The events are not part of the brief. They arrive as messages, each with the header it came with.

Ally run: section 1 names the sender (label, short id, team, level), with no head tower and no identity. Sections 2 and 3 are replaced by
what the run's sender may already see. That is the `tower_list` and `board_read` scope of a remote turn: only workspaces inside the
project the sender's team binds, and only that team's boards. Section 4 is left out (the digest is local). Section 5 is that device's
last ally-run note. Section 6 lists the tools the level allows. Added: **Thread with this device** (≤ 1,500), the last 6 messages
exchanged with it (from `link.log` and the outbox), each cut to 240 characters, under the note that they are peer text.

## Tower tools in a run

Every tower tool in a run is a thin client of the server over the control socket, authenticated by the run token. The server enforces
the run's kind on every request, in addition to the hooks in the run.

| Tool | In a local run | In an ally run |
|---|---|---|
| `tower_list`, `board_read` | The full answer, as today | Scoped to the sender's team, as in a remote turn today |
| `boss_status`, `call_tower` | Inside the workspace, as today | `boss_status` only (allowlisted) |
| `tower_send` | Sent by the server as the tower identity, with the header the server writes (`id=sb-tower-<ws>`, `role=tower`, `head=yes` when it is). With `device`, `reply: true`, and `for: <local session>`, the ally's reply goes to that session (**Replies for a main**) | Only to the sender's device. Any other target needs the gate, and the server checks that the hub holds an Allow for that call's gate dialog (`toolCallId`). A target that is a tower identity of this machine is refused outright, since it would carry peer text into a local run. |
| `tower_reply` (new) `{ to, message, reply? }` | One message to one local session by id or name, sent as the tower identity under the header. This replaces "answer with intercom send". | Gate, as for `tower_send` to a local target. `origin=remote:<device id>` is stamped by the server. |
| `boss_open_main`, `boss_close_main` | Run by the server with the persisted ledger and limits; `close-main` goes out from the tower identity | Gate (dispatch: allowed) |
| `link_request` | Unchanged (the boss approves) | Refused at every level, as today |
| `tower_done` | Ends the run | Ends the run |

pi-intercom's `intercom` tool is blocked in runs with a pointer to `tower_reply` and `tower_send`. Without the block, a reply would
carry the run's own short-lived id, and the answer would reach a pi that had already exited.

`prompts/tower.md` changes in three places: replies go through `tower_reply`; "you are woken for the events below and end with
tower_done and a handoff note; a main's result comes back as a new event, so do not wait for it"; and "the boss may write to you from the
GUI; a boss message is an instruction". "Never ask the boss" stays.

## Ally runs

- An ally message never shares a session with local context. Each run serves one device. The messages from that device that are waiting
  when the run starts go into it, up to 5, oldest first. A message that arrives during the run waits for the next fresh run (D1).
- The run's level is fixed when it is claimed: the server computes it from `link.trust` or the unattended policy, and the run's hooks
  read the policy again and take the lower of the two. A sender that leaves the roster before the run starts has its messages dropped,
  as today. One that leaves during the run gets its run ended with `quit`.
- At `dispatch` (an unattended device's controller) the run has the full tower tools of a local run, minus `link_request`, and keeps the
  device's own guards.
- A `confirm-request` from an ally's gate at `forward` stays a GUI alert for the boss and wakes nothing (D5).

### Replies for a main (D4)

A local tower often asks an ally on a main's behalf. Under "every ally message gets its own session", the answer would reach an ally
run with no local context, and passing it on to the main would need a gate confirm every time. So the local tower names the asker:

- `tower_send({ device, workspace?, text, reply: true, for })` in a local run. `for` is a live local session (id or name) that is a main
  of the tower's workspace. The server records `{ envelope id, device, for: <session id>, expires: 24 h }` in
  `tower/<ws>/awaiting.json`.
- The ally answers from the ally run that the question started. When it calls `tower_send` back to the asking device, its server sends
  a `tower-reply` envelope instead of `tower`, carrying `inReplyTo` (the envelope id that started the run) and the text. `tower-reply`
  is a new message kind with its own plaintext, in `src/link/kinds.ts`, `tests/link/vectors.json`, and straw-relay's kind table, as
  `board` was added in 5b. An ally on an older build sends a plain `tower`, which gets an ally run as before.
- The asking server takes a `tower-reply` as a reply only when `inReplyTo` names an open record, the envelope comes from that
  record's device, and the record has not been used. It then closes the record. Anything else (no record, wrong device, used,
  expired) is treated as a plain `tower` message and gets an ally run.
- The reply reaches the main as peer data, by the path a tower took a delivery by in step 3: the server offers it over
  `straw-boss/link`, the main takes an offer only from the server's `intercomId`, holds it until it is idle, and sends it into its
  session as a `straw-link` custom message with `triggerTurn`, under the verified header plus `kind=link_reply` and `for=<tower>`. No
  run starts and nothing enters a tower.
- That main's run is then a remote turn at the replying device's level, with the step-4 hooks (**Security**).
- If the main has gone (not live, or no longer the tab's main), the reply falls back to an ally run, whose brief says which main asked.

## Security: Remote turns after the split

**Stays as built in step 4 and 5b:**

- Trust levels and where they come from (`link.trust`; the unattended policy file and its owner check; `reply` by default).
- The allowlist: `read` of tracked files; `grep`, `find`, `ls` inside the project with the `tool_result` filter; `tower_list` and
  `board_read` scoped to the senders' teams; `boss_status`; `todo`; `tower_send` to the sender.
- The deny list, refused outright for any tool's path arguments.
- The gate (owner `straw-link-gate`, keyed by `toolCallId`, full arguments up to 12,000 characters, 10 minutes, terminal and page, first
  answer wins) and `forward`'s `confirm-request` and `confirm-answer`.
- `link_request` refused at every level.
- The verified header for the first message (`id=link:<device>`, label character set, `team=` from this computer).
- `origin=remote:<device id>` on everything an ally run sends to a local session. The server stamps it now, not the run.

**Simplified for towers, because remote content never shares a tower session with local context:**

1. Run classification (`turn.ts`: from a `straw-link` `message_start` or `message_end` to `agent_settled`, the lowest level of several
   senders) is replaced by the run's kind and level, fixed at claim for the whole session. There is one sender per run.
2. Holding a delivery until the tower is idle, and the 10-minute "waited for an idle tower" notice, are gone for ally runs: the session
   starts with the message. The server raises the notice instead when an ally message waits more than 10 minutes for an ally run slot.
3. `hideOldRemote` and the `context` marker for older peer text are not needed in towers: no local run ever holds peer text. A test
   checks that a local run never receives a `straw-link` or `link` event.
4. The documented compaction limit (a peer's text surviving unmarked in a summary) does not apply to towers: an ally session holds
   the brief and peer text only.
5. The documented `origin=` limit for pi-intercom's own tool after a gate approval is gone: runs cannot use that tool, and the server
   stamps `origin=` on every send.
6. In towers, the `straw-link-seen` session entry is replaced by the run records' taken ids.
7. "A steer into a run that began local makes it remote" can no longer happen in a tower: a link event is never offered to a local
   run.

**Reopened by D4, for mains only.** Step 3 sent link deliveries to towers only, so only towers needed the gate (review R-F003). A
`tower-reply` for a main puts peer text into a main, which runs at full rights. The step-4 machinery therefore stays, scoped to mains
that take such a reply:

- run classification from the `straw-link` message to `agent_settled`;
- the allowlist, the deny list, the gate, and `forward`;
- `link_request` blocked;
- `hideOldRemote` in later runs;
- `straw-link-seen`;
- the documented compaction limit.

It is bounded: only a reply, only from the device asked, once, to the main the local tower named, within 24 h. The remote-turn hooks
stay registered in every joined session, so this needs no new hook code. B6 gets a fresh-context security review for it.

**New guards:**

- The server enforces the run token's kind on every control request (the table above). An ally run cannot message a tower identity of
  this machine.
- An ally run's `context` event drops any pi-intercom message, as a backstop. The run's own intercom id is fresh, and no header names it.
- Every control connection opens with the `hello` secret, and on Windows the state directory carries an owner-only ACL
  (**The control socket**); a pipe's name and a file mode protect nothing there. Run tokens are held in memory only, so reading
  `server.json` gives no run's privileges.

## Unattended devices (Straw Link step 6, rebased)

- The infra runs `herdr server` and `cli.mjs serve` (launchd with `UserName`, or a systemd user unit with lingering), both under
  `env -i`. It no longer needs a boot pi session to hold the link, since the server is the holder.
- "Opening a tower for a controller" becomes `ensure-tower` for the bound project's workspace. The server makes the workspace
  (`herdr workspace create --cwd <bound project>`) when none exists, only for a controller at `dispatch`, and only inside the policy
  file's bound directories. The controller's message then gets an ally run at `dispatch`.
- `dialog-open` and `dialog-answer` to controllers, `unit-status`, and reports work as the Straw Link spec says. Since the hub is in the
  server, it is the server that relays a dialog to the controllers.
- `assertSettingsSafe` and the project trust question apply to its runs too. A trust question on an unattended device has nobody to
  answer it, so its infra pre-trusts the bound projects (`trust.json`); without that, the run fails with the reason as a `notice` to the
  controller.

## GUI

The map's structure does not change: the same bases, the same tower unit with the same key, and subagents and outposts where they are.
What changes:

- **The tower unit's key** is the tower identity's id. It is stable across runs, so `/w/<ws>/s/<sb-tower-ws>` is a lasting link.
- **States.** `working` (a spinner) while a local run works, `waiting` while it waits on a dialog, `commanding` as today, and when no
  run is live, the idle mark labelled **standing by** (zh-TW 待命). The server keeps the identity's intercom status in step with the run's
  (`thinking`, `tool:<name>`, `idle`), so `sessionMark` and the dashboard need no new case.
- **Queue.** Events waiting for a run show as the unit's queued rows (the existing queued-message bubbles), each labelled with its kind
  and sender.
- **Ally runs** hang under the tower like its subagents, labelled `ally run · <device label>`, with their own comms while they live.
- **Comms.** While a local run lives, its session file. While standing, the last local run's file, read only, with a divider per run
  and its handoff note. The composer stays enabled and says "Wakes the tower". Send posts a `boss` event, so nothing is typed into the
  shell. Keys and the terminal mirror refuse with 409 `standing` while no run is live.
- **Notices**: a refused settings check, a crash loop with **Retry**, an ally message waiting more than 10 minutes.
- Net snapshot: `Base.tower` gains `service: { state: "standing" | "waking" | "running" | "closing" | "held", queued: number, run?: { id,
  kind, startedAt }, allyRuns: { device, startedAt }[], lastRun?: { endedAt, outcome } }`. Readers that do not know `service` keep
  working.
- A session in a tower pane whose id is not the workspace's `tower` token is the tower's run. `net.ts`, the dashboard, and `tower_list`
  fold it into the tower unit and never list it as a unit of its own.

## `gui.json` and its successor (for straw-boss-desk's owner)

This section stands alone, so straw-boss-desk's owner can review it without the rest. The owner agreed to it on 2026-10-26 (D11).

**What stays.** `gui.json` keeps its path (`$PI_CODING_AGENT_DIR/straw-boss/gui.json`), its write by rename (mode 600), and every field
the contract names: `port`, `token`, `pid`, `started`, `stopped`, `version`, `herdr`, `owner`. The URL stays
`http://127.0.0.1:<port>/<token>/`, and **Ready** and **Moved** do not change. One field changes meaning: `pid` and `started` now name
the sb server, the process that serves the GUI, instead of a pi session. `owner` becomes `sb server (pid N)`. `ownerSession` (not in the
contract) is the server's intercom id.

**What changes for a reader.**

- **Gone** no longer depends on a pi session surviving. A server that went down without a stop is started again by the next pi session's
  look (within about 6 s while any pi runs) or by its supervisor. With no pi session and no supervisor it stays down until something
  starts it, which the shell now does itself with `cli.mjs up`.
- `stopped` in `gui.json` now means that the GUI listener was stopped on purpose (`/boss gui stop`). The server goes on running the
  tower services and the link. The whole server stopped on purpose is `server.json`'s `stopped`. `up` and `serve` clear both.
- A restart or upgrade keeps the port and token (**Restarts and upgrades**), so the shell's webview reconnects without reading anything.
  Moved is the only case in which the shell reads a record again.

**The successor: `server.json`.** It sits beside `gui.json` and describes the stack, not only the page. The shell may read `pid`,
`started`, `version`, `herdr`, `mode`, `desk`, `stopped`, `restarting`, and `gui: { port, token, stopped }`. `socket`, `secret`, and
`intercomId` are for sessions and runs only, and like the token the file is a secret, never logged.

**On the happy path the shell reads no file at all.** `cli.mjs up` prints everything it needs (**`up`'s output**), and `cli.mjs status`
prints the state below as one JSON line. Files are for watching between launches.

### States for a shell

| State | How to tell from the files | `cli.mjs status` | What the shell does |
|---|---|---|---|
| live | `server.json` has no `stopped` and no `restarting`; its `pid` is alive and started at `started`; a GET of the URL answers 200 | `{"state":"live", …}` | Show the page. |
| moved | live, but `gui.port` differs from the URL the shell loaded | `live`, with the new `url` | Load the new URL once it answers 200. The token stays. |
| restarting | `server.json` has `restarting` whose `since` is less than 15 s ago | `restarting` | Keep the page; its stream reconnects on the same URL. After 15 s, treat it as gone. |
| gui stopped | live, and `gui.stopped` (`gui.json`'s `stopped`) is set | `gui-stopped` | Say the GUI was stopped; `up` starts it again. |
| server stopped | `server.json` has `stopped` | `stopped` | Run `up` at the next launch (it clears `stopped`). |
| gone | none of the above: the PID is dead or started at another time, `restarting` is older than 15 s, or the URL has not answered for 15 s | `gone` | Run `up`. |

**Migration**, in three releases that the shell pins one at a time:

| Release | `gui.json` | `server.json` | The shell |
|---|---|---|---|
| S1 (the server ships) | Written by the server, contract unchanged | Written, documented as the successor, with `up` and `status` | Nothing has to change. It may use `cli.mjs up` instead of waiting for a pi to host the GUI. |
| S2 (one minor later) | Still written | The documented contract | Uses `up`'s output and `status`, keeping `gui.json` as a fallback |
| S3 (after the shell confirms S2 in its pin) | Still written, marked deprecated in how-it-works | Contract | Drops the fallback. `gui.json` stays on disk for older shells and is never removed without a note in the release. |

No schema version is added. The shell keeps pinning the pi-straw-boss version, as the contract already asks. how-it-works gets the
**States for a shell** table as it stands here.

## Desk mode: what changes

Desk R1 (`gui.json` by rename, Windows start times, `windowsHide`) is on `main` and stays. The rest of desk mode targets the seams this
spec replaces:

| Seam | Change |
|---|---|
| The switch `STRAW_BOSS_DESK=1` | Stays. The server reads it from its own environment at start: the one the shell gives `cli.mjs up`, or the one a pi session inherited from its Herdr server. A live server started without it is restarted by `up` with the switch (**Starting**). |
| S1, the tower opens the GUI at its start | **Dropped.** The server serves the GUI from its start. No tower or pi is needed for the page to answer. |
| S2, no browser | Stays: `/boss gui` prints the URL and opens nothing in desk mode. The server itself never opens a browser. |
| S3, the state path | Stays. |
| S4, `gui.json` as contract | Stays, extended by **`gui.json` and its successor** and **States for a shell**. |
| S5, `desk up` | **Replaced by `cli.mjs up --dir <folder> --label <name> [--timeout s] [--exact]`** at the path of **Where the command lives**. Steps: `herdr`, `integration` (S6), `server` (start, find, restart for the switch, or upgrade), `base` (`desk.json`, as specified), `tower` (`ensure-tower`, no pi, no 90 s restore wait: a restored run is quit rather than kept), `gui` (the URL answers). With `--dir`, `up` refuses with exit 2 when the switch is missing, as specified. Without `--dir`, `up` only makes sure the server runs. |
| S6, Herdr's pi integration | Stays, installed by `up`. |
| S7, S8 | On `main` (R1). The detached start adds `windowsHide` too (**Starting**). |
| S9, hidden features | Stays. The server reads the switch and tells the page. |
| S10, native folder dialog | Unchanged (the page and the shell's preload). |
| "Out: a GUI server that runs without a pi session" | Reversed by the boss's decision above. |
| Stopping the stack | straw-boss-desk runs `cli.mjs stop` when it quits, then `herdr server stop`. Its next launch runs `up`. |

For the shell, `start.ps1` and the macOS kit become: start `herdr server` with the switch, run `cli.mjs up`, and record PIDs. A cold
Windows start no longer waits for a tower pi (66 s measured) before the page answers.

### `up`'s output

One JSON line on stdout:

```json
{
  "url": "http://127.0.0.1:52662/<token>/",
  "pid": 41234,
  "started": "2026-10-26T08:40:06.000Z",
  "version": "0.45.0",
  "package": "0.45.0",
  "mode": "detached",
  "desk": true,
  "server": "found | started | restarted | upgraded",
  "steps": [{ "name": "herdr", "ok": true, "ms": 40 }, { "name": "server", "ok": true, "ms": 1200, "detail": "restarted: desk switch" }],
  "warnings": [{ "code": "server_newer", "text": "the server runs 0.46.0, this package is 0.45.0" }],
  "workspace": "w_…", "pane": "p_…", "tower": "sb-tower-w_…", "created": false, "integration": "current"
}
```

- `version` is the live server's, and `package` the version of the package `up` ran from.
- `steps` lists every step that ran, in order.
- `warnings` codes: `server_newer`, `desk_on` (a desk server found by an `up` without the switch), `remote_off` (remote access did not
  resume, with the reason), and `integration_installed`.
- The last five fields come only with `--dir`.
- Exit codes:
  - 0: done.
  - 1: a step failed. One JSON line `{ "step", "reason", "steps", "warnings" }` goes to stderr; a `gui` failure adds the last 20 lines of
    the server's log.
  - 2: usage, or `--dir` without the switch.
  - 3: the command cannot run (`tsx` not found, or the Windows ACL could not be set).
  - 4: from `serve` only, a live `serve` server already runs.
- A second `up` while one runs waits for it on `server.lock` (up to `--timeout`), then reports what it finds.

## Migration from resident towers

- When the server first runs, a live resident tower (an older pi holding the workspace's `tower` token) keeps its workspace. The
  service waits and registers its identity only once that session leaves. Two towers never hold one workspace.
- A new-code pi started as a resident tower (`STRAW_BOSS_ROLE=tower`, or `roles/` says tower), for example opened by an older session's
  `ensureTower` or resumed by a Herdr restore, asks the server for `ensure-tower` on its workspace and quits once the server has written
  the `tower` token for the identity. Its tab becomes the standing pane's tab. A message sent to that pi's own id after it quit waits in
  the broker's mailbox for an id that never comes back, so the hand-over happens at the pi's start, before any agent learns its id.
- `roles/` records with role `tower` are converted into `service.json` and then deleted. Main records are untouched.
- The `straw-boss/link` channel keeps serving requests from sessions of the previous build for one minor release; after that it carries
  only the server's offers of replies to mains (**Replies for a main**).

## Build steps

Inserted before Straw Link step 6, which is rebased on them. Each step passes `npm run check` and `npm test`, updates
`docs/how-it-works.md`, and is merged on its own.

1. **B1, server skeleton.**
   - `src/server/{main,cli,record,socket}.ts` and `cli.mjs`.
   - `server.json` and `server.lock`.
   - The control socket or named pipe with the `hello` secret, and the Windows ACL.
   - Liveness, and the detached start from a session's look with `windowsHide`.
   - `serve` (with its take-over), `up` without `--dir` (with `server`, version, and desk handling), `stop`, `status`, and `restart`.
   - The restart path that keeps the port and token, and `upgrade`.
   - `tsx` as a dependency.
   - The intercom connection through the headless kit, and `/boss server`.

   Nothing moves yet.
2. **B2, the GUI moves.**
   - `host.ts`'s server half moves into the server. Sessions stop hosting and adopting, and `/boss gui` and the GUI commands ask the
     server.
   - `gui.json` is written by the server under the unchanged contract, and `server.json` gets `gui`.
   - Remote access resumes as today.
   - how-it-works gets **States for a shell**.
3. **B3, the link holder moves.** The holder runs in the server, sessions stop being candidates, and session requests go over the socket.
   The channel is kept for the previous build.
4. **B4, tower service without runs.** Identities, standing panes, tokens, head watch, digest, `ensure-tower`, the opener ledger and
   `close-main` in the server, conversion of resident towers. A tower here takes no events yet (behind a flag in tests only).
5. **B5, local runs.**
   - Queue, wake, claim, the brief, `tower_done`, timeouts and crashes.
   - Receipts after the fsync, the sender's `~r<n>` retry and its dedupe.
   - Tower tools over the socket, `tower_reply`, the `intercom` block, the prompt change.
   - `assertSettingsSafe` before every run.
   - The GUI's tower states, queue, and composer wake.
   - A proposed pi-intercom change: a mailbox flush waits for receipts (**Queueing and concurrency**).

   From here the tower is not resident.
6. **B6, ally runs.**
   - Routing link events into ally runs, session-level remote turns for towers, the guards of **Security**, and server-side token
     enforcement.
   - The ally brief and thread.
   - Replies for a main (D4): `tower_send`'s `for`, the `tower-reply` kind in this client, `tests/link/vectors.json`, and straw-relay's
     kind table, and the offer to the main.
7. **B7, desk.** `up --dir` with the desk steps, the desk seams as **Desk mode** says, desk mode's how-it-works section.

Then Straw Link step 6 (unattended devices, as rebased above), step 7 (joining over the tailnet), and step 8 (relay deployment and
trials), unchanged otherwise.

## Tests and anchor

- **Unit.**
  - Server record and lock: two starts at once start one; a dead PID or a reused one is not live; `stopped` holds against a session's
    look; `up` and `serve` clear `stopped` in `server.json` and `gui.json`.
  - The control socket: a connection without the secret, or with a wrong one, is closed with no answer.
  - The detached spawn's options are `{ detached: true, stdio: "ignore", windowsHide: true }`.
  - The constructed environment carries no `PI_INTERCOM_*`, `PI_SUBAGENT_*`, or `STRAW_BOSS_ROLE`.
  - `cli.mjs` resolves `tsx` from its own package and exits 3 without it.
  - `up`:
    - `server` is `found`, `started`, `restarted` (desk switch), or `upgraded` (older server);
    - `server_newer` without `--exact`, and exit 1 at `version` with it;
    - `desk_on`;
    - the full JSON shape;
    - exit codes 0 to 3.
  - `serve`: it takes over a detached server with the same port and token; a live `serve` exits 4.
  - Every kind of restart keeps the port and token, and a taken port moves only the port.
  - `status` gives each state of **States for a shell**.
  - The queue:
    - order (boss first), coalescing, and persistence across a restart;
    - dedupe by message id with `~r<n>` removed, and by envelope id;
    - the receipt goes only after the fsync.
  - The brief builder's caps per section and in total, the ally scope, and no digest or local note in an ally brief.
  - `tower_done` is refused while events are outstanding. Idle, too long, and crash outcomes, flags, and the crash-loop hold.
  - Run token enforcement for each tool and kind, including an ally run refused a send to a tower identity.
  - Claim by pane and PID, a resumed run quit, a hand-started pi accepted.
  - `tower-reply`:
    - taken only for an open record from its device, once;
    - anything else becomes an ally run;
    - a gone main falls back to an ally run.
- **Integration (fake Herdr and a real pi-intercom broker, as `tests/link/remote-world.ts` builds them).**
  - `call_tower` to a workspace with no run wakes one, the event arrives, and the reply leaves with `id=sb-tower-<ws>`. A main's later
    reply wakes a second run.
  - Mail sent while the server is down arrives from the broker's mailbox.
  - A server killed between reading a message and its receipt: the sender's retry delivers it once.
  - The broker behaviors in **Reality anchor** (no resend, unknown outcome on disconnect, mailbox flush without receipts, `SESSION_HELD`)
    are pinned by tests, so a pi-intercom upgrade that changes them fails here.
  - The guard keeps a main across a server `upgrade`. Mains are demoted 15 s after a `stop`.
  - An old-build session neither adopts the GUI nor takes `holder.json`.
- **Real pi session (faux model, as `tests/link-session.test.ts`).**
  - A local run gets the brief in its role section and its events in order.
  - An event arriving mid-run is offered at idle and taken once.
  - `tower_done` quits pi, and the `intercom` tool is blocked.
  - An ally run is remote from its first message, and its `context` never holds a pi-intercom message.
  - A main that takes a `tower-reply` runs a remote turn at the replier's level, with the gate, and later runs hide the reply.
- **Settings.** A refused `assertSettingsSafe` starts no run, keeps the queue, and raises one notice per minute at most.
- **Live (AGENTS.md, Live checks), in scratch workspaces of the default Herdr with servers started under `env -i`:**
  1. The first pi of a fresh agent dir starts the server, and the GUI shows each tower standing.
  2. A main's `call_tower` wakes a pane in the existing tower tab, the run answers and exits, and the tab stays.
  3. The GUI composer wakes the tower.
  4. Killing the server mid-run: the run reconnects to the restarted one and finishes, and the page reconnects on the same URL.
  5. Two agent dirs and a local relay: an ally message wakes an ally pane at `reply` while a local run works, and its gate shows in the
     GUI; a `tower_send` with `for` gets its reply into the named main.
- **Windows VM:**
  1. `cli.mjs up` brings the page up without a tower pi.
  2. The detached server opens no console window: no window appears, and the node process has no main window handle.
  3. A second local account cannot connect to the pipe (closed with no answer) and cannot read `server.json`.
  4. `up` after `stop` brings the server back; `up` with the switch against a server started without it restarts it on the same URL.
- **Review.** The change touches a shared contract (`gui.json`, `server.json`, the control socket), security (remote turns, the
  reopened main path), and the process model, so B1, B2, B3, B5, and B6 each get a fresh-context reviewer after their anchor passes.

## Risks

- **The server is now a single point.** While it is down, every workspace lacks a live tower. Mains survive a restart within the guard's
  15 s grace, and the broker keeps mail for 24 h, but a server that stays down demotes mains. The session looks and the supervisor keep
  that window short, and `/boss server` says why it is down.
- **Cost per wake.** Each wake starts pi (seconds on macOS, up to a minute cold on Windows). Coalescing and handling mid-run events in
  the live run keep the count down. A tower that is messaged often runs often, which is the boss's trade for not keeping it resident.
- **Mailbox flush without receipts.** Mail queued in the broker while the server was down is marked delivered when the server
  registers (`broker/broker.ts:1337`). A crash while the server writes that batch loses it with nobody told. The window is short and
  bounded (**Queueing and concurrency**); closing it needs the pi-intercom change B5 proposes.
- **A plain `intercom send` to a tower identity during a restart** fails with an unknown outcome and is not retried by Straw Boss. The
  sending agent is told it could not be confirmed.
- **pi-intercom's mailbox, receipt, and `SESSION_HELD` rules are relied on.** The integration tests pin them, and a pi-intercom upgrade is
  checked against them, as the sidecar checks `extension-bus-v1`.
- **D4 puts peer text into mains again**, bounded as **Security** says and guarded by the step-4 hooks.

## Decisions (boss, 2026-10-26)

The boss took every recommendation of the first revision's open questions. straw-boss-desk's owner also agreed to D11.

| # | Question | Decision |
|---|---|---|
| D1 | Queueing | Local events go to the live local run. Every ally message gets a fresh session, never mixed with local context. One ally run takes up to 5 waiting messages from the same device, oldest first; a message that arrives during the run waits for the next run. |
| D2 | What "送出" means as a wake trigger | Two things only: a late outcome of the tower's own send (a delivery refused or failed, an opened main that failed, a reply arriving), and the boss asking the tower from the GUI. A send on its own does not wake it. |
| D3 | Timers | No general timers. `tower_done({ wakeAfter })` only: one pending per workspace, 5 to 240 minutes. |
| D4 | An ally's reply to a question the local tower asked | `tower_send({ device, …, reply: true, for: <local session> })`. The reply goes straight to that main as peer data, with no ally run and nothing entering a tower (**Replies for a main**). A reply without `for` gets an ally run. |
| D5 | An ally's `forward` confirm request | It does not wake the tower. It stays a GUI alert for the boss. |
| D6 | Concurrency | One local run per workspace, and one ally run per workspace beside it in its own pane of the tower tab. At most 4 pi runs per machine (`towerRuns`). |
| D7 | Lifetime of a server started from pi | Resident until stopped on purpose. A `detached` server exits only when its Herdr server has been gone for 60 s. A `serve` server lives as its supervisor says. |
| D8 | A stop on purpose leaves no live tower | Accepted. Mains are demoted after 15 s, and the stop warns of it first. Sessions do not restart a stopped server by themselves. |
| D9 | Command names | `/boss server [stop\|restart]` inside pi, and `cli.mjs <serve\|up\|stop\|status\|restart>` at the path of **Where the command lives** for shells and supervisors (the docs call it `sb`). |
| D10 | The idle tower pane | A shell prompt. The GUI says "standing by" (待命). |
| D11 | `gui.json` | Unchanged as the GUI's contract, with `server.json` as the successor, migrated in three releases. |
| D12 | Run limits | 20 minutes per run. A steer after 60 s idle without `tower_done`, and an end 5 minutes later. The service is held after 3 failed runs in 10 minutes. |

## Review record

Review by straw-boss-desk's owner, 2026-10-26, all applied:

1. **Windows named pipe.** A random name is no ACL. Every connection now opens with a `hello` secret kept in `server.json`, and the
   state directory gets an owner-only ACL on Windows. A Windows test checks that a second account is refused. The claim that the
   mode-600 argument carries over is gone (**The control socket**).
2. **Locating the CLI.** The stable path is `<agent dir>/npm/node_modules/pi-straw-boss/src/server/cli.mjs`. It runs under plain Node 22
   with `tsx` resolved from the package itself (**Where the command lives**).
3. **The desk switch on a live server started without it.** `up` with the switch restarts it, and `server: "restarted"` says so
   (**Starting**).
4. **`stopped`.** `up` and `serve` clear it in `server.json` and `gui.json`. Desk stops with `cli.mjs stop`, and its next `up` brings the
   server back (**Stopping**).
5. **serve and detached.** Desk uses `up` only, and `serve` is for supervisors. `serve` takes over a live detached server, and gives
   exit 4 when a live `serve` server runs, with the reasons (**Starting**).
6. **Windows detached start.** It uses `windowsHide`, with a unit test and a VM check.
7. **Version skew.**
   - `up` reports `version` and `package`.
   - An older server is upgraded.
   - A newer one gets a warning, or exit 1 with `--exact`.
8. **Restart and upgrade keep the port and token.** Moved is the only re-read (**Restarts and upgrades**).
9. **`up`'s JSON fields** are listed (**`up`'s output**).
10. **States for a shell** are in one table, which goes into how-it-works.

The open risk of the first revision ("whether the broker re-sends an un-acknowledged delivery", B5) is settled from pi-intercom 0.17.1's
source: it does not re-send (**Reality anchor**). The design now retries from Straw Boss's sender and dedupes in the server, and the
remaining gap (a mailbox flush without receipts) is documented, with an upstream change proposed.
