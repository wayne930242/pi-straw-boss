# The sb server: a light Straw Boss backend and a tower that wakes

Status: design, not built. The boss decided every open question on 2026-10-26 (**Decisions**). Four reviews of the same day are
applied: two rounds by straw-boss-desk's owner and two fresh-context reviews (**Review record**).
Base: pi-straw-boss 0.43.2 (`main` at `ce55ec4`, Straw Link steps 1 to 5b merged), pi 1.4.0, Herdr 0.9.5. The server requires
pi-intercom 0.18.1 or newer; the broker facts below are read from the installed 0.18.1.
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
- "server restart 也要讓 agent 或 user 有辦法做，不然很難 debug": agents and the boss can see the server's state and log, and restart it
  (**Seeing and restarting the server**).
- The member and main distinction stays.

This spec calls that process the **sb server**. It is one Node process per state directory and Herdr server, it is not a pi session,
and it runs from the installed pi-straw-boss package.

## Scope

- In: the sb server's process model and lifecycle; what moves out of pi sessions; the tower service, its wake triggers, queue, wake
  protocol, brief, done and handoff; how tower tools reach the server; what changes in Remote turns; unattended devices; the GUI's
  tower states; `gui.json` and its successor; desk mode's changed seams; the server's log, status, and restart for agents and the boss;
  build steps; tests.
- Out: a remote MCP server, Phase 2 tailnet direct, the relay (beyond two new kinds in its table, `caps` and `tower-reply`), the switchboard, Linux as a desk
  platform, any change to members, mains, promotion, or the guard's rules beyond reading `restarting`, and sidecars beyond the endpoint
  they call to open a tower.

## Terms

- **sb server**: the backend process (`src/server/`, shipped as `dist/server/`). One per state directory and Herdr socket (**One per
  state directory and Herdr server**).
- **Tower service**: the server's part that stands in for a workspace's tower: its intercom identity, its tab, its tokens, its queue,
  and its runs.
- **Tower identity**: the intercom session the server registers for one workspace's tower. On the primary server its id is
  `sb-tower-<workspace id in lowercase>` and its name `tower · <workspace label>`; on a secondary server the id is
  `sb-tower-<slot8>-<workspace id in lowercase>` and the name `tower · <workspace label> · <slot8>`, where `<slot8>` is the first 8 hex
  of the slot's hash (**One per state directory and Herdr server**). Herdr workspace ids are short counters, so two Herdr servers reuse
  them, and both servers register in one broker scope, where a second registration of an id is refused (`SESSION_HELD`). Its cwd is
  `<slot>/tower/<workspace id>` (a folder no pi ever runs in), and its Herdr pane the tower tab's standing pane. The workspace token
  `tower` names it.
- **Standing pane**: the tower tab's one permanent pane. It sits at a shell prompt while no run is live.
- **Run**: one pi session the tower service starts, with a run id (16 random hex). A **local run** works the workspace's local events in
  the standing pane. An **ally run** works the messages of one Straw Link device, in a pane of its own split into the tower tab.
- **Event**: one item the tower service queued for a run: an intercom message to the tower identity, a Straw Link `tower` envelope, a
  boss message from the GUI, or a notice the server raises (**Wake triggers**).
- **Brief**: the short context a run gets at its start (**The brief**).
- **Handoff note**: what a run leaves for the next run of the same kind (`tower_done`).

## Reality anchor

What the design rests on, read from the code and from the installed pi-intercom 0.18.1 on 2026-10-26:

- The GUI server runs inside a pi session (`createHost`, `src/host.ts:22`). Every interactive session looks at `gui.json` every 2 s and
  adopts a server whose owner died (`adopt`, `src/host.ts:106`). `gui.json` is a documented contract for straw-boss-desk
  (how-it-works, **`gui.json` is a contract**), written by rename since desk R1.
- The link holder is elected among joined sessions and towers (`LinkElection`, `src/link/election.ts`; `outranks` prefers a newer build,
  then a tower). Towers reach it over the intercom extension channel `straw-boss/link`, in chunks of 12,000 base64 characters, because
  the broker caps an extension payload at 16 KiB (`CHUNK`, `src/link/wire.ts:14`).
- A link delivery waits until the tower is idle and goes in as a `straw-link` custom message with `triggerTurn` (`pump`,
  `src/link/runtime.ts:209`). A run is a remote turn from that message until `agent_settled` (`src/link/turn.ts`), and later local runs hide
  older peer text (`hideOldRemote`, `src/link/turn.ts:79`, used at `src/link/hooks.ts:89`).
- Every Straw Link plaintext is decoded strictly: a structure with trailing bytes or another field count is refused (`src/link/canon.ts:46`),
  and an unknown kind is dropped (`unknown-kind`, `src/link/envelope.ts:110`). So no field can be added to an existing kind without older
  receivers dropping it, and a new kind is dropped by older receivers and refused by a relay that lacks it.
- A tower is started with `herdr agent start <name> --kind pi --pane <pane>` (`startPi`, `src/herdr.ts:197`). This needs the pane at a
  shell prompt: it answers `agent_pane_busy` otherwise. `agent start` takes no environment for an existing pane. When pi exits, the pane
  returns to its shell.
- A Herdr restore drops pane environment variables and pane tokens. A role comes back only from Straw Boss's own records (`src/roles.ts:6`,
  `src/session.ts:74`; desk-mode spec, **A restored tower**).
- pi lets an extension register a CLI flag and read it (`registerFlag`, `getFlag` in pi's `ExtensionAPI`).
- The opener remembers each sender and request only for the life of the tower session (`seen`, `src/opener.ts:49`).
- The tower prompt says "answer with intercom send" (`prompts/tower.md:3`). Every Straw Boss message carries a code-written header whose
  `id=` is the sender's own intercom id (`stamp`, `src/header.ts`; `selfParty`, `src/reach.ts`), so a reply goes to that id.
- The digest is read into the tower's system prompt under `Since your last run:` at the start of each run (`src/session.ts:149`).
- The guard keeps mains only while the workspace's `tower` token names a live intercom session (`src/guard.ts:48`). With no live tower,
  mains are demoted after 15 s (`src/guard.ts:10`).
- Several modules the server needs import pi's peer dependencies as values: `@earendil-works/pi-tui` (`src/dashboard.ts:4`, through
  `net.ts`; `src/pairing.ts:3`), `typebox` (`src/tools.ts:3`), and `@earendil-works/pi-coding-agent` (`src/trust/ask.ts:4`). pi provides
  them in its own process; they are not on disk under `<agent dir>/npm/node_modules`, so a plain `node` process cannot load these modules
  from the installed package (reproduced by the review: `ERR_MODULE_NOT_FOUND` for pi-tui and typebox).
- pi-intercom ships TypeScript sources only (`"main": "index.ts"`), so loading its client in a process that is not pi needs a TS loader.
  The sidecar takes the `tsx` that npm hoisted beside pi-intercom (`src/agent/paths.ts:106`).
- pi-intercom 0.18.1 (`broker/broker.ts`, `index.ts`, `config.ts`, `broker/paths.ts`):
  - `PI_INTERCOM_STABLE_ID` gives a pi a fixed intercom id (`index.ts:597`).
  - A live process that holds an id keeps it, and a second registration of that id is refused with `SESSION_HELD` (`broker.ts:543`).
  - A message to a disconnected id goes to the broker's mailbox, unless it is a blocking ask (`broker.ts:862`, `:881`). The mailbox is in
    memory only, keeps a message 24 h (`:44`), and holds at most 256 messages across all sessions (`MAX_MAILBOX_MESSAGES`, `:45`). Past the
    cap the oldest is evicted and its delivery marked `E_DELIVERY_EVICTED`, with nobody told (`:1124`, `:1132`).
  - When the session it was kept for is not live, a message may instead go to a live session with the same mailbox identity, a name and
    cwd (`findUniqueLiveSessionForDisconnectedSession`, `:865`, `:1464`, `:1481`).
  - The broker stays up while its mailbox holds mail, rechecking at the next expiry (`scheduleShutdownCheck`, `:440`). 0.17.1 exited 5 s
    after its last session left, mail or not.
  - The broker never sends a message again by itself. To a receiver that registered `acknowledgesReceipts`, a live delivery waits up to
    5 s for the receipt (`RECEIPT_TIMEOUT_MS`, `:49`; `completeSocketDelivery`, `:1162`). A receiver that disconnects first, or does not
    answer in time, makes the broker answer the sender `delivery_failed` with `delivery: "unknown"`, `retryable: true`, `outcomeKnown:
    false` (`failPendingReceipt`, `:1200`; `settlePendingReceiptsForSocket`, `:1212`, called on socket close at `:391`). The message is
    not put in the mailbox. A retry under the same message id is accepted and delivered again (`replayOrReject`, `:1225`, "a retry of an
    unconfirmed delivery is safe", `:1241`).
  - A message to an id the broker has never seen fails with `E_TARGET_NOT_FOUND` (`:759`).
  - Mail kept for a disconnected id is written to the session when it registers and marked `socket_delivered` at once, with no receipt
    wait (`flushMailboxForSession`, `:1288`, `:1344`).
  - The outbox (the path Straw Boss sends by) uses the request id as the message id (`index.ts:1269`), refuses a request id already used
    in the same runtime (`index.ts:1188`), and reports every failed delivery as `failed`, code `delivery_failed`, with the broker's reason
    in `detail` and no `outcomeKnown` (`index.ts:1283`). The sender cannot tell an unknown outcome from a refusal.
  - A registration may carry `herdrPaneId`, and the broker resolves it to a Herdr location (`broker.ts:567`, `:709`), against the default
    Herdr only (AGENTS.md, Live checks).
  - `PI_INTERCOM_SCOPE_ID` splits sessions, channels, and broadcasts into separate scopes (`config.ts:23`, `broker.ts:189`), and on
    Windows `PI_INTERCOM_TRANSPORT=tcp` or `PI_INTERCOM_TCP` chooses the TCP transport (`broker/paths.ts:52`, `:57`).
- A process that is not pi already runs Straw Boss's net modules: the net sidecar's headless kit gives them an intercom channel and
  outbox over a raw `IntercomClient`, and starts the broker when none runs (`createHeadlessKit`, `src/agent/kit.ts`; `intercomClient`,
  `src/agent/sidecar.ts`). The sidecar strips every inherited `PI_INTERCOM_*` variable; the server keeps scope and transport
  (**Starting**).
- `assertSettingsSafe` (`src/trust/settings.ts`, branch `fix/settings-precheck`, in review; B5 depends on its merge) runs before `startPi`
  in `spawn.ts`, `opener.ts`, `towertab.ts`, and `stash.ts` `popBase`, so pi never starts in a folder whose `.pi/settings.json` it would
  choke on.

## Design in one page

```text
pi session (any)           sb server (one per state dir and Herdr)                       tower tab of workspace W
 ├ joins tab net ──────────┐ ├ GUI server (gui.ts, control.ts, hub, trust, spawn, closer)   ┌ standing pane: shell prompt
 ├ board_set               │ ├ link holder (default Herdr only)                             │   └ local run: pi --sb-run <id>
 ├ call_tower ── intercom ─┼►├ tower service W: identity sb-tower-w ── queue ── wake ───────►│
 ├ openTower ─── socket ───┼►│    tokens, head watch, digest, opener ledger, close-main     └ ally pane: pi --sb-run <id>
 ├ boss_server ── socket ──┼►├ status, log, restart                                          ▲
 └ bridge (dialogs) ─ intercom ─► hub                                                          │
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

### One per state directory and Herdr server

- One sb server per state directory (`$PI_CODING_AGENT_DIR/straw-boss`, else `~/.pi/agent/straw-boss`) and Herdr socket
  (`herdrSocket`, `src/endpoint.ts`).
  - **The default Herdr** is the socket `herdrSocket` gives with `HERDR_SOCKET_PATH` and `HERDR_SESSION` unset, for the server's `HOME`
    and config folders. A shell that sets `HERDR_SOCKET_PATH` to that same path is on it too.
  - **The primary server** is the one for the default Herdr. It keeps its files at the contract paths (`server.json`, `gui.json`, …) and
    is the only one that holds the link. pi-intercom resolves Herdr locations only against the default Herdr (AGENTS.md, Live checks),
    so Straw Link's routing by pane cwd works only there.
  - **A secondary server** serves any other Herdr socket (a scratch or named session). It keeps its files under
    `servers/<first 16 hex of sha256(socket)>/` with the same names, serves its own GUI from there, and runs tower services, but holds no
    link. Its towers work as on the primary one, within what the broker can resolve.
  - A pi session uses the server of the Herdr it runs under, and only that one.
- `server.lock` makes check-and-start atomic. It is created exclusively (`wx`) and records its holder: `{ pid, started, by, since }`.
  It is held only while a start or a restart is being decided and carried out, never by a running server.
  - It is taken over only when its holder is dead: its PID is not alive, or started at another time than recorded (`holderAlive`, as
    the link holder's record is judged). A holder that is alive keeps it however long it takes, and a slow cold start on Windows is
    not mistaken for a dead one. One looker at a time decides that, through `server.lock.stale`.
  - A lock older than 120 s is taken over even from a live holder, since no start or restart may take that long (a start waits 20 s for
    `hello`, 60 s on Windows; a restart waits up to 15 s for the old server to go first, so about 80 s at most); the taker logs it.
  - A request that finds the lock busy waits for it as long as a start can hold it: the start wait plus the exit wait of the same timers
    (30 s, and 70 s on Windows), for `/boss server`, `restart`, `stop`, and `serve`; `up` has one time for the whole call (below). None
    of them turns a cold Windows start into `busy`.
  - **`up --timeout`** bounds the whole `up`: the lock wait, the old server's exit wait (for a restart), and the start wait together, from one
    deadline, so `up` does not run past `--timeout` (every wait inside it is cut to what is left: the lock, the old server's exit, the
    supervisor's and the retake's waits for a `serve` server, the start wait, each hello probe, the control call of a restart, the Herdr
    check, and the native calls that protect the folder; a start with nothing left of the time starts no server). The default is 90 s on
    Windows (a lock wait of up to 30 s ahead of the 60 s start wait) and 30 s elsewhere (10 s ahead of the 20 s start wait). A larger
    `--timeout` does not lengthen the start wait, which is the platform's. When a wait runs out, the JSON line on stderr names it
    beside `step`, as `"wait": "lock"` (`server.lock` held by another start or restart), `"start"` (this `up` started the server and it
    did not answer `hello`), `"hello"` (another requester's start was under way, the lock free, and no `hello` came), or `"exit"` (the
    old server did not leave for a restart). A failure that is not a wait has no `wait` field. A failure that left no `start-error.json`
    because the state folder could not be protected carries its `startError` (`code: "acl"`) in the JSON all the same.
  - Why not the `gui.lock` rule (taken over after 10 s by mtime) with a refresh every 2 s: a refresh depends on the holder's timers
    firing, and a holder blocked on a synchronous call loses the lock while alive. Death is what makes a lock stale, and a start time
    tells it apart from a reused PID.
- `server.json` (mode 600, written by rename) records:
  - `pid` and `started` (process start time, through `startOf`), `version`, `herdr`, and `mode` (`detached` or `serve`);
  - `desk` (whether the server runs with `STRAW_BOSS_DESK=1`);
  - `intercom: { scope, transport }`, the broker scope and transport the server registered with;
  - `gui: { port, token, stopped }`;
  - `stopped` (set only by a stop on purpose) and `restarting: { began, since, reason, by }` (**Restarts and upgrades**): `began` is
    when the restart or start began and never changes, `since` is touched every 2 s while it is under way, and a touch keeps `reason`
    and `by`;
  - `lastError: { at, code, text }`, the last failure the server recorded (**Seeing and restarting the server**), and `log`, the log's
    path;
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
- Known gap (B3R-F003): the hello secret alone gives full `link` admin, since `link` does not check a run token's kind. B5 and B6 must add
  that check before runs reach the socket.
- The secret is only as private as `server.json`. On Windows the server sets the ACL of the state directory, `straw-boss/` and never the
  agent directory above it, before it writes the secret:
  - The owner's SID comes from `[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value`, read through PowerShell with
    `execFile`, no shell.
  - The folder's ACL is set with `icacls <dir> /inheritance:r /grant:r *<owner SID>:(OI)(CI)F *S-1-5-18:(OI)(CI)F`, without `/T`.
    Accounts are named by SID only, never by a localized account or group name. SYSTEM is `S-1-5-18`.
  - It is checked by SID through `(Get-Acl <path>).Sddl`. No localized text is parsed.
    - The folder's DACL must be protected (`D:P`), with exactly two allow ACEs, the owner SID and `SY`, and no inherited ACE.
    - Each secret file (`server.json` of the slot and of every secondary slot in `servers/<hash>/`, `gui.json`, `paired.json`, everything under `link/`) must hold allow ACEs for the owner SID and
      `SY` only, explicit or inherited. A file written by rename after the `icacls` run inherits exactly those two from the protected
      folder, which is just as safe, so an inherited ACE is accepted on files.
  - **The folder is protected before the first file is created in it, at every start.** The second Windows pass found `server.lock`, the
    placeholder `server.json`, and `server.log` with the parent's inherited ACEs (Users read, Authenticated Users modify outside the
    profile) for the first 4 to 7 s of a cold start, until the server's PowerShell call. So every process that is about to create a file in
    the slot (the requester before it takes `server.lock`, the server before its log; the placeholder is written inside the requester's
    start, under the lock) first makes `straw-boss/` and checks it, with native calls and no PowerShell (whose start costs 2 to 5 s):
    - `whoami /user /fo csv /nh` for the owner's SID, once per process (only the SID is kept, a user does not change; the folder is
      checked again at every start, since other code can delete and make `straw-boss/` again, and a session lives for days);
    - **No native call ever changes an owner** (R12-F001): `icacls /setowner` is not used at all. A successful `/setowner` takes over a folder
      another account made (and granted the user WRITE_OWNER, or WRITE_DAC, which the protect call turns into it), after which the owner
      checks pass on a folder whose maker still holds handles opened while it owned it. An elevated token's folders are BA-owned by default,
      and BA is an accepted owner (below), so none is needed.
    - **An existing folder is read first and touched only when it has to be**: `icacls <dir> /save <tmp>` (UTF-16 SDDL, no localized
      text), and a DACL that is already exactly the owner and SYSTEM (`folderProblems`) changes nothing: one icacls call, no PowerShell, on
      a normal start. Only a wrong DACL is acted on, and then only after **one PowerShell reads the folder's owner as a SID**
      (`GetAccessControl(…Owner).GetOwner([SecurityIdentifier])`, after the Constrained Language check): the user, BA and SYSTEM go on to
      `icacls <dir> /inheritance:r /grant:r *<owner SID>:(OI)(CI)F *S-1-5-18:(OI)(CI)F`, without `/T`, passed on to what is created in it;
      any other owner, or an owner that cannot be read, is refused untouched ("belongs to another account (<SID>)", the remedy, exit 3):
      the protect call on a foreign folder would give the user WRITE_OWNER, the state any later takeover or repair needs. A DACL that
      `/save` is not allowed to read (exit 5) counts as wrong. A folder made by this process under the temporary name (below) is wrong by
      construction (the parent's DACL) and gets the protect call at once, with no owner read;
    - The DACL that is read back (after a protect call, and for a new folder) must be protected
      with exactly the owner and SYSTEM as allow ACEs and none inherited (`folderProblems`), or nothing is written. A foreign ACE
      another account left, which `/grant:r` does not remove, is refused here and not after the lock, the placeholder, and the
      secrets were written into it.
    - **A folder that is not there is born protected.** Making `straw-boss/` and then protecting it leaves it with the parent's broad
      ACEs for the time of those calls (443 ms on the VM with an agent folder outside the profile). So the starter and the server make it
      under an unpredictable name beside it, `straw-boss.<16 hex>.tmp`, run the two calls
      above (protect, read-back) on that name, check that nothing was put into it, and only then rename it to its final name. The final name does not exist
      while any call runs. When the final name appeared meanwhile (another process was quicker), the temporary folder is dropped and the
      folder that is there is handled as an existing one (read first, touched only when its DACL is wrong and its owner is acceptable). A temporary folder that fails a check is removed.
      `servers/<hash>` of a secondary slot is not made this way: it is made with `mkdir` inside the protected `straw-boss/` after it
      is in place, and inherits the owner and SYSTEM grant.
      - **A filtered (UAC) token cannot always `/setowner`** (VM pass 4, F1; history: since R12-F001 no `/setowner` is called at all, so a refusal can no longer happen and this is kept as the reason none is needed): outside its profile, without a WRITE_OWNER grant from the
        parent, it gets exit 5 on a folder it owns (Administrators is deny-only in that token), and every start there failed with a wrong
        "belongs to another account". So a `/setowner` refusal (5, 1307, 1314) is **never final**: the protect call that follows decides (the
        owner has WRITE_DAC; a folder another account owns that grants the user nothing fails there with exit 5, told as such). Nothing
        native can tell whose folder it is: `dir /q` cuts the owner column at 23 characters, and the names in a listing are ones other
        accounts can create (a folder named after the user's SID is no proof), so no listing is read. **The exact owner is checked
        where it cannot be forged**: the folder's `O:` from `(Get-Acl).Sddl` must be the user's SID (`ownerProblems`, in `aclProblems`):
        - in the **launch PowerShell before `Win32_Process.Create`** (the answer line of a script cannot be forged by the folder's owner, a
          marker file can): a different owner is rc -2, nothing is created, and the starter fails with `acl` "the folder belongs to
          another account (<SID>), not to <SID>" (exit 3), with no plain-spawn fallback, whose own check would refuse it as well;
        - in the server's own check (`serve`, the plain spawn) and when it reads the marker, before any secret is written.
        An alias of the user's own built-in account (`LA`, `LG`, `DA`, `DU`) is accepted, and so are SYSTEM (`SY`, R11-F004) and
        **BUILTIN\Administrators (`BA`, `S-1-5-32-544`) as an owner, for every entry including `straw-boss\` itself** (VM pass 5b): an
        elevated token's default owner is BA, and the server an elevated `up` starts writes `server.json` and `start-error.json` while the
        launch PowerShell is still running, after the `/setowner /T` pass and before the read-back, so ~50% of elevated cold starts failed
        with "belongs to another account (BA)". BA-owned objects are made by an elevated token, by SYSTEM, and by holders of
        `SeRestorePrivilege` (Backup Operators). An administrator and SYSTEM can read the folder whatever its owner or DACL, and a backup
        operator can read and write any file, so BA ownership gives no account anything it lacks; the threat the owner gate stops is another
        standard account owning an entry. A filtered token passes the gate with a BA owner when an elevated run granted the user full
        control of what it made. The launch script and `ownerProblems` use the same rule. **BA is not accepted as an ACE**: the DACL rule
        (allow ACEs for the owner/user and SYSTEM only) is unchanged. A filtered token that cannot protect a BA-owned folder still gets the
        protect step's refusal ("run pi once as administrator, or delete the folder"): the owner gate comes after it.
      - **The ownership of a folder is never taken natively** (R11-F001, R12-F001; VM pass 5b, the decoy). Where another standard account
        made `straw-boss\` first and granted the user WRITE_DAC or WRITE_OWNER, a `/setowner` that succeeds would make the user its owner
        and the owner check would pass on a folder whose attacker still holds handles that were opened while they owned it, and could
        change its DACL through them later (add an inheritable read ACE, let a file inherit it, remove it). The same holds for the temporary
        folder a start makes, which another account with Modify on the parent could delete and re-create under the same name during the
        protect call: that folder lands in place still owned by the attacker, and the PowerShell gates refuse it with no secret written.
        The owner is gated in PowerShell BEFORE any secret exists: the launch script before the server is created (rc -2), `ACL_STEPS`
        (`CheckOwner $dir`, before its `/inheritance:r`; `serve` and the server's own script), and the read-back. **One rule for the
        accepted owners in every check: the user, BA, SYSTEM** (`OWNER_OK_SIDS`: `ownerProblems`, the launch script's check, the native
        owner read, the scripts' owner walks).
        **Nothing is created or written under a foreign-owned folder** (R13; VM pass on f72b184, where a refused start had left
        `servers\<hash>\{server.json, server.log, start-error.json}` and `server.lock` in the attacker's folder). The **owner gate**
        (`ownerGate`: one PowerShell reads the folder's owner as a SID) runs in `lockFor` BEFORE anything is made or changed in an existing
        folder, and again right after `prepare` for a folder that start has just made (the first start ever, or a swapped temporary folder
        that landed there), so before the lock, the placeholder record, the log or `start-error.json`; `launch` passes it too before its
        placeholder (a server that went away between the look and the lock). The refusal goes to stderr and the JSON output of `up`
        (`startError.code` `acl`), never into the folder. The read is remembered by the folder's file identity (volume and file index), so a
        long-lived pi session reads it once, `protectFolder` does not read it again for a wrong DACL, and a folder made again under its name is
        read again. **Cost:** one PowerShell on a cold `up` unless this process has already read this folder's owner (one more beside the launch PowerShell; log phase `owner-gate ms=…`, to be measured on
        the VM), and on a `stop` of a server that is down (it writes `stopped`). **A request that finds a server running** (`up` again, `stop`
        of a live server, `status`, a session's look) takes the lock without the gate, but its look at the record passes the **trust gate**
        (R13-F003, below): the first look of a process at a folder that has a record reads the owner (one PowerShell); every later one in the
        same process reads none. The owner read for a folder is made once per folder identity; in a `secondary` slot it is passed between the
        protect call and the `mkdir`s of `servers\<hash>` (R13-F002), so a folder that landed foreign gets not even those empty folders.
        The folder is passed to the PowerShell in the environment (`SB_OWNER_DIR`), never quoted into the script: PowerShell reads U+2018 to
        U+201B as single quotes too (R13-F001). A refusal found by the launch script (rc -2) is not written to `start-error.json` either (R13-F004).
        **The trust gate (R13-F003; closed for a folder the owner read refuses, with the residuals below, before B2 to B4 send session content to the server):** a record is what a folder another account made can
        hold too (an account that can create entries in `PI_CODING_AGENT_DIR` makes `straw-boss\` with a `server.json` of its own, names its own pid, and
        uses any free pipe name or one whose DACL denies the victim), and the old behavior trusted it: a victim's `up`, `stop` or `restart` wrote
        `server.lock`, `server.json`, `server.log` lines and `start-error.json` inside the attacker's folder, and `status` and `up`'s `url` were
        spoofed. Now `probe` (the one look every request makes: a session's look, `status`, `up`, `stop`, `restart`, `serve`, the waits of a
        start) passes the owner gate (`ownerGate`) as soon as the folder holds a readable record, BEFORE it asks whether the pid lives, sends a hello,
        or hands the record to any caller. A folder whose owner is not the user, BA or SYSTEM (`OWNER_OK_SIDS`) is refused with the same `acl`
        error as a start's ("belongs to another account", exit 3 in the shell, told once by a session as "the sb server was not looked at"): nothing
        is sent to the record's pipe (not even a hello), and nothing is written, because every write path in `client.ts` is behind a probe.
        The record is read FIRST and a record that was read is used only after the gate has passed (b1f-F001: asking "is there a record?" before reading it was passed by a `server.json` that appears and disappears by rename: 1.4% of 89,538 probes returned the attacker's record unjudged); a record file that could not be read (another uid's, a link) is judged too. No file of the slot is read before the folder is judged: `cli logs` (the rotated logs too, and `--follow` once the log first appears), `boss_server logs` (both gate when the state folder exists, not when `server.log` does), `describe`'s `start-error.json` and `up`'s error JSON (which prefers the `acl` refusal to the folder's own `start-error.json`) pass the gate first (b1f-F004). A folder with no record is not read otherwise (nothing is trusted yet; a start's gate reads it before its first file, as before).
        **One read judges three paths (b1f-F002):** the state folder, the slot's own folder and the record are read in the same PowerShell (an `index:SID` line each), so a record or folder another account planted inside a folder the user owns (a folder made before B1 by other modules' plain `mkdirSync`, with an inherited broad DACL) is refused too. They are judged at this read only: the record's file identity changes on every write, so it is not remembered. The folder is remembered as verified only when its DACL is exactly the owner's and SYSTEM's (read back by `icacls /save` after the owner read); an open folder is protected at the gate right after the owner read (`icacls /inheritance:r /grant:r`, read back with `/save`) and then remembered; if that protect fails it is told once (a process warning in the CLI, the look's notify-once in a pi session) and the folder is read again at most every 60 s, at once when a record in it changed identity. **Residual (R4-F002):** that 60 s window is keyed on identities taken before the read, so an A-B-A swap of the record (the attacker's record put back after the user's was read) is trusted for up to 60 s. A path that was there when the read began and reads `-` went away meanwhile: that is a failed read (a wait, nothing remembered), and the owner script stops at its first error (`$ErrorActionPreference = 'Stop'`) except for a path that is no longer there (`catch { if (Test-Path -LiteralPath $p) { throw } }`, the walk's pattern). **The record's content is bound to the file judged:** `readRecord` takes the file's identity from `fstat` of the handle it read, and after the gate `trusted` refuses (a wait) a record whose file at the path is not that one (a user-owned file renamed over it during the read).
        **Residual (b1f-F003):** an A, B, A swap during the read (the attacker's folder X renamed away, a user-owned folder Y put at the name while PowerShell reads it by path, X put back before the identity check) passes the "replaced" check, and X is then remembered as verified for the process. It needs an account that can rename entries in the parent and has a user-owned folder to rename; the identity cannot be read from the PowerShell's own handle without `Add-Type`, which Constrained Language Mode forbids. Documented, not fixed. **Residual (R4-F001):** the protect call (`secure`, the gate's `shut`) opens the folder by path after an identity check; a swap in the one process start between the check and icacls opening the path can have the DACL of a folder that was not judged changed to the owner's and SYSTEM's, which the owner could set alone and which changes no owner. The sentence above about a folder replaced while it is read holds for a one-way swap too: the identity is taken before the reads and `remember` stores it only when the folder at the name still has it (R3-F001).
        **A read that ran out of time is a wait (b1f-F006):** `execAsync` marks only its own timer's kill as `ETIMEDOUT` (another signal and a `maxBuffer` kill keep their own words), the gate throws it as `GateTimeout`, a request tells it as exit 1 with `wait: "start"` and not as `acl`, and it is NOT remembered: the next request reads again.
        **Cost, measured on the Mac as a count of PowerShell starts; the Windows time is for the VM:** one PowerShell per process per folder
        identity, for any process that finds a record: a session at its first look, each `cli.mjs status`, `stop`, second `up` (a shell command
        is a new process: one read each, where it read none before; counts per command are in `docs/how-it-works.md`). The memos (`verified` and `refused`, by volume and file index) hold a verified folder and a **refusal**: a
        session looks every 2 s, and a foreign folder costs one PowerShell for the process, not one per look. A read that FAILS (Constrained
        Language Mode; not a timeout) is remembered for `OWNER_READ_RETRY_MS` (60 s) and told again meanwhile without a new PowerShell. The wrong-owner
        verdict lasts as long as the folder's identity does; an owner changed on the same folder is seen by the next pi process.
        **The read is asynchronous (B1 follow-up):** `ownerGate` starts the PowerShell as a child process and awaits it (`execAsync`, with `execFileSync`'s
        error shape and a closed input), so a pi session's event loop (its screen, its timers, the GUI, the link) is never held for the 2 to 5 s of a
        PowerShell start. `Ctx.gate` and `Ctx.prepare` may answer with a promise, `lockFor`, `launch` and `probe` await them, and the gate inside
        `prepareSlot` (between the protect call and the `mkdir`s of a secondary slot) is awaited before they are made. Requests that come while a read
        runs for a folder (a session's looks, `status`) share it (nothing outside `client.ts` reaches the gate in B1: the link and the GUI do not use the sb record yet, and `gui.json` in `handover.ts` is read with no gate, as before): one `whoami` and one PowerShell between them, one verdict for all,
        a refusal or a failed read included. A folder replaced while its owner is read (another file index afterwards) is not the folder that was read:
        the read fails and nothing is remembered, and the next request reads the folder that is there. The remaining synchronous native calls are
        `whoami`, `icacls /save` and the protect call of `protectFolder` (tens of milliseconds each); the PowerShell of `secure`'s wrong-DACL path
        is skipped for a folder the gate has read, which is every folder a probe has passed. Shell commands (`status`, `stop`, `up`) use the same
        asynchronous read; nothing waits on it with the loop held.
        **POSIX (B1 follow-up):** where there is no ACL the same gate is `uidGate` (`record.ts`): a `stat` of the state folder, the slot's own
        folder (a secondary slot) and the record file, following links (a link to another account's folder is that folder), each compared
        with `process.getuid()`. A path that another uid owns is refused with the words of the Windows gate ("could not check … before trusting
        or writing to it: the folder … belongs to another account (uid N), not to uid M. Run pi as that account, or delete the folder …, then
        start again."), as the same `acl` error (exit 3 in the shell, "the sb server was not looked at" once in a session), BEFORE the record is
        read, a hello is sent, or a file is written; the folder is checked before the record, and a refusal stops at the first path. A path that
        is not there is nothing to refuse; a `stat` that fails for any other reason is a refusal that says so. It starts no process and needs no
        memo. A link is judged twice (b1f-F005): its own owner (`lstat`), then its target's (`stat`). uid 0 is ACCEPTED as an owner, as BUILTIN\Administrators and SYSTEM are on Windows (root is no adversary to the user); a server a `sudo` run started then shows as live but unreachable, like an elevated one on Windows, and `secretDir`'s EPERM or EACCES on a root-owned folder is told as "made by a sudo run: sudo chown -R it, or remove it with sudo". The record is opened with `O_NOFOLLOW` and its owner read from the open handle (`fstat`), so what was stat-ed is what is read, and `prepareSlot` honors `gate` on POSIX too, before it makes the folder. Volumes that ignore ownership (macOS uid 99) and NFS with all_squash are refused for every folder, with no way around it. `cli.mjs up` and a session's `boss_server restart` run it (`trusted`) before
        they read the record at all.
        The protect call on a swapped temporary folder, and on an existing user-owned folder swapped between the identity check and the call
        (the gate refuses it afterwards), adds the user and SYSTEM where the attacker granted WRITE_DAC and leaves the owner as it was: the
        changes `protectFolder` can make to a foreign folder.
        Both ACL scripts check below the folder the same way: the folder's own owner first, then ONE walk (R13) that reads every entry's
        attributes, link type and owner (a SID, through .NET) once, refusing a junction, a symbolic link or a foreign owner, and only then `/setowner /T /C /L /Q` (PowerShell, which turns BA- and SYSTEM-owned entries
        into the user's, entries already checked) and `/reset /T /C /L`, so a foreign entry is refused with nothing below the folder changed.
        **Residual (R11-F003):** the walk and the calls are not atomic; an account that can already create entries below the folder (only
        through the known plain-`mkdir` windows of other modules, before the folder was protected) can plant one in between, which `/reset`
        then gives the user's inherited full control and a later start's `/setowner /T` could take. **`icacls /T /L` DOES descend a junction**
        (VM pass 6, 8e: `icacls <dir>\* /grant Everyone:(R) /T /C /L` changed the ACL of a file in the junction's target; `/L` only keeps icacls from
        following a link given as the top-level argument): the walk's refusal of junctions and symbolic links is what protects the target, and a
        junction planted in the gap between the walk and the `/setowner` or `/reset` call would be descended, so its target's owner and DACL would
        be changed. The gap is bounded the way the rest of this residual is (an account that can create entries below the folder before it is
        protected, and then wins a race of a few hundred milliseconds); the read-back lists only the entries of the walk and does not see the target.
        The folder's own protection bounds it; the read-back checks the owner of everything it lists.
        **P3 (VM pass 6, tmp-swap):** an account that can write the PARENT of `straw-boss\` (the agent directory, in a shared place) can always win
        the swap of the temporary folder (60/60, with a 2 ms poll): it renames `straw-boss.<hex>.tmp` before the start has protected it. The outcome is
        safe (the gate refuses the planted folder, no secret is written, nothing is taken over) but that account can make every first `up` in the
        shared parent fail with exit 3. It is not fixed: the parent being writable by another account is what the swap needs, and the same account
        could delete `straw-boss\` or plant it first. The refusal text for a planted folder that grants the victim nothing ("could not protect … tmp")
        does not name the swap.
      - **What is below is listed without following links** (R8-F003): Windows PowerShell 5.1's `Get-ChildItem` follows junctions, so the
        scripts walk the folder with `[IO.Directory]::GetFileSystemEntries` and refuse any entry with the `ReparsePoint` attribute
        that is a name-surrogate link (`Get-Item -Force` gives it `LinkType` `Junction` or `SymbolicLink`; one whose type cannot be read is refused too)
        (`sb-reparse-point <path>`, told as "a link or junction was found inside the state folder, which is refused"), before any `icacls`
        call below runs and again when the SDDLs are read back. The `/reset` carries `/L` too. Other reparse points (OneDrive and other cloud placeholders, dedup)
        are ordinary files and folders and are walked as such, so an agent folder in OneDrive is not refused. A folder that vanishes between being listed and
        being walked (the link stale-lock guard, `outbox\<team>`) is skipped; one that is there and cannot be listed is thrown.
      - **Everything below is the user's too** (R7-F002, R8-F001, R8-F002): `/reset` and `/inheritance` replace DACLs and never owners, so after the reset one
        call, `icacls "<dir>\*" /setowner *<sid> /T /C /L /Q`, makes the folders below (`servers\<hash>`, `link\…`) the user's, and the
        read-back lists every folder below and the files it names (`server.json`, `server.lock`, `server.log`, `gui.json`, `paired.json`, every file under `link\`,
        and each `servers\<hash>\server.json`; not the files in `board\`, `stash\`, `agents\` or the other files of a secondary slot), and each must be the user's (`O:`) with allow ACEs for the user and SYSTEM only,
        inherited ones allowed (`folders` and `files` in the answer; a folder that another account owns would keep an owner's implicit
        WRITE_DAC over what is written in it later). The owner is taken BEFORE the reset, so the reset can use the owner's WRITE_DAC; an
        owner or a DACL that one call could not fix is refused by the read-back whichever of the two the other call fixed. A temporary file
        that is renamed into place (`writeJson`, the pairing file) is created new (`wx`) under a name with a random part, so one that was
        already there, with another account's owner, is never written to.
      - Every `icacls` call carries `/L`, so a link is acted on itself and never its target, and `secure` looks for a link first.
      - The rename is tried again on `EPERM`, `EBUSY` and `EACCES` (a scanner or the indexer holding the temporary folder): waits of 10, 20,
        40, 80, 160, 320, then 500 ms three times, 2.1 s in all. A handle that stays is told as that ("something is holding the new folder …
        Start again in a moment"); a temporary folder that cannot be removed then is left to the next start's sweep.
      - At every start, a `straw-boss.<16 hex>.tmp` folder older than a minute (a start that crashed or was held between the make and
        the rename; a start's own is there for well under that) is removed, if it is a folder and not a link.
      - The temporary folder lives 35 to 130 ms with the parent's inherited ACEs (outside the profile: Users read, Authenticated Users
        modify), under a name nobody looks for; the final name never carries a broad ACE (VM pass 4, F9; accepted).
      - Only a program that failed to start is told as "not found" or "did not finish in time"; a read of the file `icacls /save`
        wrote, or a `whoami` that gave no SID, keeps its own words.
      - A PowerShell 5.1 failure is told by its message line: the first line that does not start with `At line`, `+` or `~`, not the
        `FullyQualifiedErrorId` that ends it.
    - **A failing call is told by a fixed message** for its step and exit code, with what to do, and never by the program's own text,
      which a console prints in its code page (CP950, CP932) and Node reads as UTF-8: half garbled. The program's last line is kept
      only as a detail cut to printable ASCII. For example, exit 5 on the owner step: "the folder <dir> belongs to another account,
      usually Administrators from a run of pi as administrator, and this process may not take it over. Run pi once as administrator, or
      delete the folder <dir>, then start again. (owner step, exit 5; detail: …)". Exit 87 says icacls did not accept its arguments
      (a bug in pi-straw-boss, to be reported); a missing program, a timeout, and any other exit have a sentence of their own.
    - a folder that is a link or junction (`lstat`) is refused, for `straw-boss/` and for a secondary slot's `servers/` and
      `servers/<hash>/`, before any of this and again after the icacls calls, before the DACL is read: `icacls` without `/L` would act on its target, and the files would land there.
    A secondary slot's `servers/<hash>/` is made after the state folder is protected and inherits it. Nothing is written into an
    unprotected folder: a requester whose calls fail stops with `acl` (exit 3, in the JSON's `startError`, not written to a file), and a
    server whose calls fail exits 3 and writes nothing. The native calls share the time the call has left (`up --timeout`): each gets
    what is left of it (at least 100 ms) and at most 15 s. A failed call is told by the last non-empty line of its stderr and its exit
    code, never by the message of Node's error, which begins with the whole command line (the same for the ACL PowerShell and the
    WMI start). The PowerShell step that follows stays as it is: it resets what is below the folder and reads every SDDL back.
    The DACL file has no owner: the owner is read by the PowerShell steps (above), natively only as a SID where a change is about to be made.
  - **System programs by absolute path.** A bare program name is looked for in the current folder before `PATH` on Windows
    (nodejs/node#46264), and a pi session's folder is a project. `powershell.exe`, `whoami.exe`, `icacls.exe`, `cmd.exe`, and `clip.exe`
    are called from `%SystemRoot%\System32` by absolute path (`%SystemRoot%` from the environment when it is a drive-letter absolute path, else `windir` likewise, else `C:\Windows`: a relative value would put the program and its working folder in the project) and
    run with that folder as their working directory, in the start-time reader, the ACL call, the folder's native calls, the launch,
    the hidden-folder reader, the browser opener, and the clipboard; the ACL script names `icacls.exe` by `[Environment]::SystemDirectory`.
    - **The reaper plugin** (`herdr-reaper/`, macOS and Linux) finds `herdr`, `git`, and `lsof` the same way, through its own copy of
      `exe.mjs` (the plugin may be installed from its folder alone; a test keeps the copy byte for byte equal), and a herdr that is not found
      is a failed sweep in its log.
    - **Every other program is found by a PATH search that never looks in the current folder** (`src/exe.mjs`): `herdr` (or
      `HERDR_BIN_PATH`, which must then be absolute), `git`, `tailscale`, `ps`, `sh`, and the opener and clipboard commands. Empty, `.`,
      and relative PATH entries are skipped (an empty entry means the current folder on POSIX), on Windows only `.com` and `.exe` of PATHEXT are
      taken, in PATHEXT's order (`.cmd` and `.bat` cannot be started without a shell), and the program is spawned by the path found. A program
      given as a path must be absolute. One that is not found is an `ExeNotFound` (code `ENOENT`) that says where it looked. The answer
      is kept per process while PATH is the same, and searched again once when the program is gone at its start (ENOENT). The `shutdown`
      handler reports a pane that could not be closed on stderr and goes on. `process.execPath` is already absolute.
  - Reading the SID, the server's own start time, setting the ACL, and checking every SDDL run in one PowerShell invocation, which
    answers one JSON line. **A cold start makes only one PowerShell start, the starter's.** The VM measured the launch PowerShell at
    3.8 to 16 s and the server's ACL PowerShell at 6 to 15 s, so the check is folded into the launch script (below): the starter knows the
    new pid when `Win32_Process.Create` returns, reads its start time and makes the reset and read-back in the same PowerShell, and the
    server makes none. A server of `serve`, or one the starter started by the plain spawn, has no starter's check and makes its own with
    this script.
  - Files that are already in the folder when the ACL is set (`server.lock` the starter took, `server.log` the server opened) are not
    given the folder's ACL with `/T` on the folder: that strips their inherited ACEs, and an `(OI)(CI)` grant does not land on a file, so
    they ended with an empty DACL that even their owner could not read (the VM's P2). The folder is protected first, without `/T`, and
    everything below it is then reset in one call, `icacls "<dir>\*" /reset /T /C /Q`: its explicit ACEs go and it inherits the owner and
    SYSTEM grant of the folder again, files and folders alike. It is one process whatever the number of items (a call per item took a
    process each, and `link/inbox/` alone holds up to 500 files); `/C` goes on past an item that vanishes meanwhile, and the call's exit
    code is not the check, the read-back is. The check reads `server.json` (of every slot), `server.lock`, `server.log`, `gui.json`,
    `paired.json`, and everything under `link/`.
  - If setting or checking fails, the server does not start. It writes `start-error.json` (`code: "acl"`, the reason, the SDDL it read)
    and exits 3. `up` and the session looks read that file (**Starting**).
  - macOS and Linux keep the 700 directory and 600 files they have today.
- Run tokens (**The wake protocol**) are checked on top of the secret, for requests a run makes.
- The net sidecar's Windows pipe (how-it-works, **From Claude Code or Codex**) has the same gap today. It is out of scope here and is
  recorded as a finding for the sidecar, to be fixed with the same `hello` secret.

### What the server runs from

- The server ships prebuilt. `npm run build:server` (run by `prepack`) bundles `src/server/main.ts` and `src/server/cli.ts` with
  esbuild into `dist/server/main.mjs` and `dist/server/cli.mjs`, ES modules for Node 22, and `files` in `package.json` adds
  `dist/server`.
- The server's import graph has no value import of `@earendil-works/pi-tui`, `typebox`, or `@earendil-works/pi-coding-agent`; type
  imports are fine. The build marks the three as external and fails when the bundle still imports them. B2 moves what the server needs
  out of the modules that import them:
  - `dashboard.ts` is split into its pure data (`commanding`, `markOf`, `sessionMark`, `subagents`, `artifacts`, which `net.ts`,
    `ask.ts`, `reach.ts`, `closemain.ts`, `orphan.ts`, `boardread.ts`, and `order.ts` use) and its pi-tui rendering, which stays
    pi-side with the tower widget. `host.ts → dialogs.ts → ask.ts → dashboard.ts` then reaches no pi-tui;
  - the pairing overlay (`pairing.ts`, pi-tui's `matchesKey`) stays pi-side: `/boss gui remote` in a session asks the server for the
    one-time pairing link and shows the QR overlay in that session, as the page's Phone tile already shows one;
  - the server never loads `tools.ts` or `trust/ask.ts`, which stay pi-side.
- pi-intercom's client is TypeScript (**Reality anchor**). The server loads only that through `tsx`, and only with the scoped
  `tsImport()` of `tsx/esm/api`, so its own prebuilt code is never transformed. B1 therefore adds `tsx` (`^4`) as pi-straw-boss's
  first runtime dependency; today `package.json` has none, and the only `tsx` on disk is the copy npm hoisted from pi-intercom. It is resolved from pi-straw-boss itself, with `createRequire(import.meta.url)`, never from beside pi-intercom.
  Without it the server exits 3 and names the path it looked from. If pi-intercom publishes a JavaScript build, `tsx` becomes a
  dev-only dependency. B1 asks pi-intercom upstream for one.
- B1 measures a cold `up` on the Windows VM: from `up`'s start to the URL answering 200, with the server not running and the file cache
  cold. The budget is 15 s, and B1 records the time and the share `tsx` takes. The first measurement (B1 at 271971e) found `tsx` at about
  0.2 s of 7.4 to 25.6 s and every PowerShell start at 1.7 to 3.1 s, so the cold start folds its PowerShell work into one call (**The
  control socket**), does not make the requester wait for its own start time (below), and logs each phase in `server.log`
  (`start-requested … spawnMs`, `start … boot`, `phase name=loader|acl|listen`, `intercom-connected … ms`, `ready ms`,
  `start-answered ms`, `stop-done`), so a next run shows where the time goes.
- The command is `<agent dir>/npm/node_modules/pi-straw-boss/dist/server/cli.mjs`, where `<agent dir>` is `$PI_CODING_AGENT_DIR`,
  else `~/.pi/agent` (`%USERPROFILE%\.pi\agent` on Windows). That is where `pi install npm:pi-straw-boss` puts the package, so a shell
  that installs pi-straw-boss into its own agent directory knows the path without asking anything. It runs under plain `node` 22 or newer
  (straw-boss-desk pins Node 22).
- The detached start from pi sessions uses the same `cli.mjs`. In the dev checkout, `npm run server` runs `src/server/cli.ts` through `tsx`.

### Starting

- **From pi.** Every interactive pi session in Herdr that is not a subagent and not a run checks at `session_start`, and then every 2 s
  (the adoption cadence it already has), whether a live server runs for its Herdr. It starts one only when all of these hold:
  - none is live;
  - `server.json` is not `stopped`;
  - `server.json` has no fresh `restarting`: a `since` within the last 10 s (**Restarts and upgrades**);
  - its own pi-straw-boss is not older than `server.json`'s `version`. A session on an older package never starts a server, which keeps
    an upgrade from being undone;
  - its broker scope and transport are the ones `server.json` records, or there is no record. A session on another scope or transport
    uses no server and says so once.
- It takes `server.lock` and checks those again under it. It then starts `node <cli.mjs> run --detached`.
  - **Elsewhere** it is spawned with `{ detached: true, stdio: "ignore", windowsHide: true }` and unref'd: the server is the leader of
    a session of its own, so killing its starter's process group (a pane closing, an ssh session ending) does not take it down (a test
    kills the group and checks).
  - **On Windows** `detached: true` is not enough: Node does not break away from the starter's job object (libuv never sets
    `CREATE_BREAKAWAY_FROM_JOB`, which fails where the job does not allow it), and a Herdr pane, an ssh session, or the desk's Electron may
    hold its children in a kill-on-close job, so the shared server died with whichever pane started it (the second Windows pass: the
    detached server died when the ssh session that started it closed). The server is created through WMI instead,
    `Win32_Process.Create` in one PowerShell start, a child of the WMI service. Microsoft's documentation of the method says that "unless
    the `CREATE_BREAKAWAY_FROM_JOB` flag is specified, processes created with the `Win32_Process.Create` method are limited by the job
    object", so `Win32_ProcessStartup.CreateFlags` is `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT |
    CREATE_BREAKAWAY_FROM_JOB`, the values its list documents; `CREATE_NO_WINDOW` is not in that list, so the window is hidden with
    `ShowWindow = 0` and the process has no console (`DETACHED_PROCESS`). A job that does not allow breakaway fails the creation, so the
    script makes the same call once more without that flag, in the same PowerShell start, and the answer says whether the process is
    outside the job (`outsideJob` in the `breakaway` phase), and the second try has a command line of its own, `--detach wmi-in-job`,
    so that server records it (`detach: "wmi-in-job"`) and `up`, `status`, `boss_server status`, and `/boss server` warn that it stays
    in the WMI provider host's job. The command line and folder go in the PowerShell's environment, never in
    its script, and so does the server's environment: `Win32_ProcessStartup.EnvironmentVariables` is set from the PowerShell's own
    environment (the starter's, minus its identity variables, plus `SB_LAUNCH_CMD` and `SB_LAUNCH_CWD`, which are not passed on, and
    minus `PSModulePath`, which PowerShell sets itself, and the per-drive `=C:` entries). That property replaces the default block, so the
    server has the starter's whole environment from its first instruction (`NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `UV_THREADPOOL_SIZE`,
    which node reads at process start), and nothing of it is written to disk. The server is told how it was started: the command line ends
    in `--detach wmi`, which it records in `server.json`. The pid comes with PowerShell's answer; until then the starter keeps
    `restarting` fresh as for any start, and watches the pid afterwards (a gone process is "the server exited before it answered"). The
    cost is one PowerShell start in the starter, logged as the phase `breakaway` (`ms`, `via`, `pid`, `outsideJob`, and `createMs` and
    `aclMs`, the parts of it the create and the check took) in `server.log`.
    - **The ACL check is made in that PowerShell start.** After the create, with the new pid, the script runs the steps of the server's own
      script (the start time of that pid, the `/reset` of what is in the state folder, every SDDL read back; sbr-F007: its output is pure
      ASCII, `\uXXXX` for the rest) and leaves the answer, or its error, in `acl.<token>.json` in the protected state folder: a file written
      beside its name and moved, so it appears whole. The token is 32 random hex digits that only the server's command line carries
      (`--acl-token`). The server waits for that file (at most 70 s), deletes it, and **checks every SDDL itself** (`aclProblems`, the same
      rules as its own check, for the pid it is) before it writes its secret anywhere: the ACL is set before the secret is written, and the
      read-back is made by someone before then, with the verdict taken by the server. An error marker, a marker for another pid, or none
      in time ends the server with `acl` (exit 3) as its own failing check does. When the start fails (PowerShell, WMI, or its timeout)
      the starter leaves an error marker so the server that may still come up does not wait for nothing; the plain-spawn fallback starts
      a server without a token. The answer also carries the server's start time, which the starter remembers (`rememberStart`), so it
      does not read it again.
    - **A failure is not silent.** When PowerShell or WMI fails (WMI blocked by the Defender rule against process creation from WMI,
      PowerShell in constrained language mode, a rejected flag), the start falls back to the plain spawn, since a server that ends with its
      pane is better than none on a machine where WMI is blocked, and says so: the starter passes `--detach direct --detach-reason <text>`,
      and the server records `detach: "direct"` and `detachFailure` in `server.json`. `up` then warns `breakaway_failed` in its JSON, and
      `status`, `describe`, `boss_server status`, and the `/boss server` line show the same warning ("started without leaving its
      starter's job … so it ends with the pane or ssh session that started it"), for as long as that server runs. `breakaway-failed` is
      also in the log.
    - **A PowerShell that does not answer in time is a failed start with no fallback**: WMI may already have created the server, and a
      second one would race it. The start goes on waiting for a `hello` until its time is out, and its error names the WMI start (the
      requester waits a moment for the word of a PowerShell that timed out with the end of its own wait, so the sentence is there).
    - **The script's answer line is the source of truth, and once WMI made the process nothing falls back.** The launch script sets
      `created` the moment `Win32_Process.Create` returns 0, and from then on it always prints its answer line, with rc 0 and the pid,
      whatever fails after it (the check, the marker's write or move: reported as `markerError`, and the starter then writes the error
      marker so the waiting server ends with `acl` at once, under a temporary name of its own). A failure before the create prints rc -1
      and exits 1: that, a return code other than 0, and a PowerShell that could not be started at all (`ENOENT`) fall back to the plain
      spawn. A PowerShell that ends with no usable answer line (exit 1 with an empty stdout, rc 0 with no pid, garbage) is treated as "may
      have started": a failed start, no plain spawn.
    - **A script that died before the create falls back; one that died after it does not.** The script prints the fixed line
      `sb-before-create` right before the first `Win32_Process.Create` (its stopwatch and every other statement are inside the `try`, so a
      method a language mode refuses is caught before it). A PowerShell that exits non-zero with no answer line and without that line in its
      stdout never reached the create (constrained language mode, an AMSI or EDR block, a parse error): the plain spawn, visibly
      (`breakaway_failed`). With the line and no answer, a server may exist: a failed start. **Residual:** if `$wmi.Create` itself throws
      after WMI made the process (an RPC drop on the way back), the line is there but the script's catch prints rc -1, which falls back
      to the plain spawn and may leave two servers (the second ends on the lock); the VM should check it.
    - **A cold start makes one PowerShell start** (VM pass 4, F2). Besides the server's start time, the launch script reads the
      starter's own (`SB_STARTER_PID`, after the marker is left, so the server is not kept waiting) and the answer carries it
      (`starterStarted`); the starter remembers both (`rememberStart`). The lock's holder start time waits for that (`startedOrWait`, 20 s
      grace, then a PowerShell start of its own, as for any other process) instead of asking for it at once, so a CLI `up` starts no
      PowerShell for itself. While the pid of a start through WMI is not told yet, the record's start time is not asked for either
      (`runsAs(…, startKnownElsewhere)`): the hello still has to answer, with the pid the record names.
    - **A server that cannot protect the folder says so in `start-error.json`** (F3). A server started through WMI has no exit code for its
      starter to read: a foreign ACE planted after the starter protected the folder ended `up` with "exited before it answered". The
      server writes no log, record, or secret into a folder it could not fix, only `start-error.json` (`acl`, the reason: nothing
      secret), best effort, and `up` reads it, so it exits 3 with `startError.code` `acl`.
    - **A lock that cannot be opened is repaired, never waited for** (F5). An empty-DACL `server.lock` (`D:PAI`) read as "held" wedged
      `up` and `stop` (a filtered user cannot even delete it). When `server.lock` exists and cannot be read (`EACCES`, `EPERM`), its
      permissions are reset once (`icacls <file> /reset /L /Q`: the owner can) and it is read and judged as any lock; when that fails,
      the start ends with `acl` (exit 3), naming the file and what to do (`LockUnreadable`). A lock that is gone by then is free, and a denial
      that outlives the repair is retried for about 100 ms first (a release in progress on a file system without POSIX delete); a lock that reads
      as both denied and gone is paused on 20 ms at a time, at most five times, then busy.
    - **A record of a server that is gone does not pin the broker scope** (F6). After a stop, the stopped record keeps the old scope, and
      a start in another `PI_INTERCOM_SCOPE_ID` was refused. The scope and transport are compared only while the record's process runs
      (it answers hello, or the record has a start time and the pid has it now: a server that is slow to answer keeps its scope, a pid reused after a crash does not; the look,
      `restart` and `stop`); a stopped or dead record pins nothing, and the new server's record carries the new scope.
    - **`stop` on a folder that is not the caller's** (F8) cannot take the lock; its message says that a server in it was started by
      another account, to stop it from that account (an elevated shell for an elevated run), or end its process; the sentence is added only
      to the owner and protect refusals (exit 5, 1307, 1314), other acl failures keep their own words.
    - **The hello answer proves the secret** (R8-F004). The client sends a fresh nonce with `hello`; the server answers with `proof` =
      HMAC-SHA256(secret, `<nonce>:<pid>`) and the client refuses an answer with no proof or a wrong one (`refused`): a pipe's name is free
      when its server is gone, and something else could answer or refuse there. A server of the format before this (no proof) is not live
      to this client; the format is the branch's first, so none runs in the wild.
    - **A server that runs and refused this process is alive, never gone** (VM pass 5, F11). An elevated server's pipe has a default DACL
      that a filtered token of the same user cannot open: the control connection fails with `EACCES` or `EPERM` (`ControlError` `denied`,
      told apart from `ENOENT` and `ECONNREFUSED`, which are "no server"), while the process itself is alive (a refused process query,
      `EPERM`, already counts as alive). `probe` then returns `denied` with `runs` true: `status` says `live` with `reachable: false` and a
      warning; the look and `ensure` find it and start no second server (`up` adds the warning `server_unreachable`); `stop` and `restart`
      refuse with `unreachable` ("… runs but this process may not reach it: it was probably started from an elevated pi or shell … stop or
      restart it from an elevated shell") and never mark the record stopped; the scope stays pinned. The refusal counts only when the process
      under the pid has not been shown to be another one (R9-F001): its start time is waited for, 3 s at most, and only a start time that is
      known and differs from the record's makes the record gone and pins nothing. One that is unknown (the CIM read takes 3.5 s and more on Windows,
      it failed, or the record has none) stays denied and pinned: stopping or starting over a running server is worse than a refusal. Only a hello that answers with the
      secret makes a server `live`.
    - **The hello comes before any start-time lookup** (F13). A server that answers hello with the secret and its pid is that server, so
      `probe` (and with it `stop`, `status` and a second `up`) asks for no start time, which on Windows was a PowerShell start of its own.
      The start time is asked for only when the hello fails (a server slow to answer, a reused pid).
    - **Constrained Language Mode is told as that** (F12). Both PowerShell scripts check `$ExecutionContext.SessionState.LanguageMode` first
      and throw the ASCII word `sb-constrained-language`; `execFailure` turns that word, and the engine's English refusals ("only core types
      are supported in this language mode"), into one sentence: "PowerShell runs in Constrained Language Mode (likely a policy);
      pi-straw-boss needs FullLanguage for its permission check", with the exit code, instead of the localized text that came out as `?`s.
    - **No PowerShell failure text is CLIXML.** Windows PowerShell 5.1 started with `-EncodedCommand` and a redirected stderr writes
      `#< CLIXML` + `<Objs …>` to stderr even on success (the progress records of preparing modules the first time). Every PowerShell call
      (`acl.ts`, `breakaway.ts`, `startof.ts`) is started with `-OutputFormat Text`, its script sets `$ProgressPreference =
      'SilentlyContinue'`, and a failure text read from stderr goes through `plainStderr`: when stderr starts with `#< CLIXML` its text is
      the `<S S="Error">` strings (XML-unescaped, `_x000D__x000A_` a newline); progress records are not text, so a successful run's
      progress is no error, and with no error record the last line of stdout and the exit code stand. The detail stays ASCII-only.
- The process gets a constructed environment: the session's environment minus `PI_INTERCOM_SESSION_ID`, `PI_INTERCOM_STABLE_ID`,
  `PI_SUBAGENT_*`, `STRAW_BOSS_ROLE`, and `HERDR_PANE_ID`/`HERDR_TAB_ID`/`HERDR_WORKSPACE_ID`. `PI_INTERCOM_SCOPE_ID`,
  `PI_INTERCOM_TRANSPORT`, and `PI_INTERCOM_TCP` stay, so the server registers in the same broker scope as the sessions; it records them
  in `server.json`.
- The session holds `server.lock` until the new server answers `hello` or the start budget passes: 20 s, and 60 s on Windows, where a
  cold start took 7.4 to 22.9 s in the VM and three starts in a row went past 20 s. Then it returns, and says nothing unless the start
  failed. If it failed, the session reads `start-error.json` and tells the reason once. The lock does not wait for its holder's own start
  time (a PowerShell start on Windows): it is taken at once without `started`, judged by the holder's pid alone until the time arrives,
  and written again with it by rename, only while it still holds the text it wrote.
- **`start-error.json`** belongs to one start attempt. Whoever starts a server (a session, `up`, `serve`, a restart's requester) deletes it
  under `server.lock` before it spawns, and the new server deletes it again once it answers `hello`. So `status` and `up` never report an
  earlier attempt's failure as the current one.
- Of several sessions, the lock lets one start the server. This is what "pi cli 啟動的時候就顯示運作" means here: the first pi of the
  day brings the server up, and the GUI's towers show as standing within a few seconds.
- **The starting server** touches `restarting.since` every 2 s until it answers `hello`, then clears `restarting`. When it finds no
  `restarting` (a fresh start, not a restart), it writes `{ began, since, reason: "starting", by: <starter> }` first; when it finds one,
  it keeps its `began`, `reason`, and `by` and only moves `since`. A start that dies leaves a `since` that goes stale within 10 s, and
  the record then counts as gone.
  - **From before the spawn.** On a cold Windows start the new process needs seconds before it can write anything (the VM's `status` said
    `gone` for the first 18 s). So whoever starts a server (a session, `up`, `serve`'s requester, a restart's requester) writes the
    `restarting` first, under the lock and before it spawns: into the record that is there (a dead server's, with its GUI, last restart,
    and last error kept), or, with none, into a placeholder with no socket and no secret, which moves to the new process's pid once it is
    spawned. The requester touches it every 2 s until the server answers `hello` or the start fails; a start that fails ends the
    `restarting` at once, so the state is `gone` and not `restarting` for another 10 s. The server rewrites the record as its own, with
    `restarting` kept, at its first line (before the ACL call and the code load, whose touches it makes itself every 2 s), and the full
    record, with the secret, after the ACL and when it listens. A shell sees this as `state: "restarting"` with `restarting.reason`
    `"starting"`; there is no fifth state.
  - **Another server's record is not touched without proof.** The server's own placeholder and full record are not written over the record
    of another process when that process is positively a server: its start time is known and is the one the record names (a live server
    whose `hello` was slow keeps its record), or the record changed since the server's first look (a server took it meanwhile) and its
    process runs, or its `hello` answers. A pid that merely runs is not proof: a
    crashed server's pid is reused by an unrelated process, and on Windows the start time cannot be told until a background read is in, so
    a record of a running pid whose socket nobody answers at is a dead server's, and the new server takes the record. A server that finds
    a live one after it listens closes its endpoint and ends with `start` (exit 1), writing nothing on the other's record (neither its
    `restarting` nor a `lastError`).
- **`cli.mjs up`** makes sure a live server runs for the Herdr in its environment and prints one JSON line (**`up`'s output**). Step by
  step:
  - **A record whose `herdr` is another socket than the slot's** (a copied or damaged state directory): it exits 1 at step `herdr`
    and starts nothing.
  - **None runs:** it starts one detached, as a pi session would, and waits for `hello`.
  - **Stopped on purpose:** `up` is the boss's own start, so it clears `stopped` in `server.json` and in `gui.json` (and `gui.stopped`)
    under the lock, then starts one.
  - **Live, GUI stopped:** it starts the GUI listener again on the recorded port and token.
  - **Live on an older version than the package `up` runs from:** step `version` asks for `upgrade` and starts the new server from its
    own package.
  - **Live on a newer version:** step `version` leaves the server alone and warns `server_newer` (exit 0), or, with `--exact`, exits 1
    at step `version`. It never downgrades.
  - **Desk mismatch:** `up` with `STRAW_BOSS_DESK=1` in its environment, against a live server whose `desk` is false, restarts that server
    with the switch (**Restarts and upgrades**). `up` without the switch, against a desk server, leaves it as it is and warns
    `desk_on`. Desk mode is read from the environment at start only; there is no control call that changes it.
  - **The start fails:** it reads `start-error.json` and exits 3 for `acl` and `loader`, else 1 at step `server`, with the reason.
  - The JSON's `server` field says which of `found`, `started`, `restarted`, or `upgraded` happened.
- **`cli.mjs serve`** runs in the foreground with `mode: serve`, for launchd and systemd (unattended devices).
  - **None runs:** it runs. A `stopped` it finds is cleared: a supervisor's start is the infra's explicit choice, and a stop is never
    left on a `serve` server (**Stopping**), so such a mark can only come from an earlier detached server.
  - **A live `detached` server:** `serve` takes it over. It asks that server to hand over by the restart path (same port and token,
    ≤ 10 s) and then runs in the foreground. Exiting instead would make launchd's `KeepAlive` or systemd's `Restart=` start it again and
    again, while the server that actually runs is one no supervisor watches.
  - **A live `serve` server:** two supervisors are a configuration error. `serve` prints that server's record and exits 4.
- straw-boss-desk uses `up` only (a detached server, quit with `cli.mjs stop`); `serve` is for supervisors.
- **From a pi session:** `/boss server` (status, and a start when it is down or stopped), `/boss server stop`, `/boss server restart
  [reason]`, and the agent tool `boss_server` (**Seeing and restarting the server**). `cli.mjs status|stop|restart|logs` do the same
  from a shell; the docs call it `sb`.

### Living

- The server keeps one `events.subscribe` connection to Herdr and re-reads when a new Herdr server takes over the socket. It republishes
  its tokens then, as sessions do today ("A new Herdr server"), and finds each tower tab again (**A Herdr restart**).
- When its Herdr server stops answering, a `detached` server waits and exits after 60 s without one. A `serve` server waits for as long as
  its supervisor runs it. Otherwise it stays up: it does not exit when the last pi session ends ("一般常駐").
- It starts the pi-intercom broker when none runs and reconnects with the sidecar's backoff (1, 2, 5, 10, then 30 s). While it is
  disconnected, its tower identities are not live (**Risks**).

### Stopping

- `stop` is on purpose. It warns first, because every workspace then loses its live tower and mains are demoted 15 s later.
  `/boss server stop` asks to confirm with that text; `cli.mjs stop` prints it on stderr and goes on, since a shell quitting has nobody
  to ask.
- Then it writes `stopped` under the lock, ends the runs' claims (a live run gets its `quit`, **The wake protocol**), takes the remote
  serve entry down, deregisters the tower identities, and exits.
- **Against a `serve` server**, `stop` refuses (exit 5) and says to stop the supervisor instead (`launchctl bootout …`, `systemctl --user
  stop …`). The alternative, a `serve` that respects `stopped`, would make a supervisor that restarts on exit loop on a server that
  exits at once, and would hide from the infra that its service is off.
- **Only the boss's own commands clear `stopped`:** `/boss server`, `/boss server restart`, `/boss gui`, `/boss tower`, the GUI's
  Restart server button, and `cli.mjs up` (and `serve`, as above). A start that no one asked for does not: an automatic `openTower` (a
  promotion, a member that dispatches, the two-member rule) or a `call_tower` against a stopped server fails, with the notice "the sb
  server was stopped on purpose; /boss server starts it again", told once per session. `boss_server restart` from an agent refuses
  too.
- straw-boss-desk stops with `cli.mjs stop` when it quits, and its next launch's `up` brings the server back.
- A crash, a kill, or a reboot is not a stop. The next session look, or the supervisor, starts it again on the recorded GUI port and
  token, so open pages reconnect.

### Restarts and upgrades

- Every restart goes the same way: `restart` (from `/boss server restart`, `boss_server`, the GUI, or `cli.mjs`), `upgrade`, `up`'s desk
  restart, and `serve` taking over a detached server.
  1. The requester takes `server.lock` and holds it until the new server answers `hello`, so no session look starts a server of its
     own meanwhile.
  2. It asks the old server to restart, with a reason. The old server writes `restarting: { began, since, reason, by }` to
     `server.json` and to the log. From then until the new server answers `hello`, the requester touches `restarting.since` every 2 s,
     so the record stays fresh while the old server exits and before the new one has started touching it; a requester that dies stops
     the touches, and the record goes stale 10 s later.
  3. The old server stops accepting control requests (answering `restarting`), finishes the writes in flight, flushes the queue and run
     records, closes the GUI listeners, releases its intercom ids, and exits within 10 s.
  4. The requester starts the new server, from its own package and never from one older than the recorded `version`. The new server
     keeps touching `restarting.since` while it starts.
  5. The new server starts in this order:
     - it connects to the broker and registers every tower identity first, so the guard sees live towers again as early as it can;
     - then it starts the link holder;
     - then it binds the recorded local and remote GUI ports with the same token and CSRF secret, retrying for up to 5 s while the old
       ports are let go;
     - then it clears `restarting`.
- **The guard during a restart.** A workspace whose `tower` token names an `sb-tower-*` id counts as having a live tower while
  its own slot's `server.json` has a `restarting` whose `since` is fresh (within 10 s) and whose `began` is less than 30 s ago. A guard
  counts only ids of its own slot (`sb-tower-<ws>` on the primary, `sb-tower-<slot8>-<ws>` on a secondary). So a slow restart, such
  as a cold Windows start, demotes no main. A restart that takes longer than 30 s falls back to the 15 s grace.
- So the URL does not change: a page or a desk webview only reconnects its stream, and a page from another build reloads itself at the
  same URL. The URL changes only when another process has taken the port meanwhile (Moved, **States for a shell**). That is the one case
  in which a shell reads the record again.
- Upgrades:
  - A pi session on a newer pi-straw-boss than `server.json`'s `version` asks the live server to `upgrade`, then starts the new server
    from its own package.
  - `up` from a newer package does the same.
  - A session or an `up` on an older package never downgrades the server. Only `/boss server restart --downgrade`, after a confirm,
    starts a server from an older package (an uninstalled newer version is the case it is for).
- Runs are separate pi processes, and a server restart does not end them. A run whose socket closes reconnects every second for 30 s
  with its run id, pane, and PID. It reads the new secret from `server.json`. The new server knows it from `tower/<ws>/runs/<id>.json`
  and takes it back (**Crash and timeout**).
- A session older than the server does nothing. A session from before this change does not know the server. It sees `gui.json` owned by
  a live process and leaves the GUI alone. During a restart `gui.json` has no `started`, which no old build adopts, and a takeover asked of the server is answered 409. The first server after an
  upgrade asks a live older host to hand over (`server/stop` with `take`) and binds its port and token. It sees `holder.json` held by a newer build and does not take it. If it opens a resident
  tower, the pi in that tab runs the installed (new) code and hands over (**Migration from resident towers**).

### Seeing and restarting the server

The boss asked for it: "server restart 也要讓 agent 或 user 有辦法做，不然很難 debug".

- **The log.** `server.log` in the server's slot, mode 600. It is rotated at 5 MB, keeping `server.log.1` to `server.log.3`. One line per
  event: starts, stops, restarts with their reason and requester, upgrades, runs started and ended with their outcome, crashes, refused
  connections, relay errors, and every `lastError`. It holds no message text, no brief, no token, secret, or CSRF value, and no file
  contents, as the relay's logs hold no bodies.
- **`cli.mjs logs [--lines N] [--follow]`** prints the log's tail (200 lines by default).
- **`cli.mjs status`** prints one JSON line: the state (**States for a shell**), pid, version, mode, uptime, `restarting`, `lastError`,
  the log path, the tower services with their state and queue length, and the link's state.
- **The agent tool `boss_server`**, in every joined pi session and in local runs, and in no ally run and no subagent:
  - `{ action: "status" }` answers what `cli.mjs status` prints. It works with the server down, from the files.
  - `{ action: "logs", lines? }` answers the log's last lines (at most 200).
  - `{ action: "restart", reason }` restarts the server by the restart path. The reason (1 to 200 characters, one line) goes into
    `restarting.reason` and the log, with the asking session's name and id as `by`. It refuses while the server is stopped on purpose
    (D8), at most one restart a minute is taken, and a down server is started.
  - The server refuses it for an ally run's token, and the remote-turn hook blocks it at every level, `dispatch` included, as it blocks
    `link_request`: a peer could otherwise restart this computer's server. A local run that restarts the server keeps its claim through
    the restart.
- **The GUI**: the settings panel shows the server's state, version, uptime, and last error, with **Restart server** and **Show log**
  (the last 200 lines). Both are on this computer's page only: the endpoints answer 403 `local_only` on the remote listener, as pairing
  does. Restart asks for an optional reason, `from the GUI` by default. Its confirm says that the page reconnects on the same URL.
- **Pi**: `/boss server restart [reason]` asks to confirm, then restarts.

## What moves out of pi sessions

| Duty | Today | With the sb server |
|---|---|---|
| GUI server: `gui.ts`, `control.ts`, the dialog hub, trust serve, spawn and deploys, closer, mirrors, documents, uploads, remote access and pairing | The session that hosts it (`host.ts`), adopted by survivors | The server. The hub owns `straw-boss/gui/<hash of the server's intercom id>` with no local bridge. Bridges in sessions do not change. |
| Link holder: relay streams, inbox, outbox, presence, boards, admin, `link_request` checks, confirms | The elected session (`election.ts`, `runtime.ts`) | The primary server, the only candidate; a secondary server holds no link. It still writes `holder.json` and takes `holder.lock`, so an old build sees a live holder of a newer version and leaves it. |
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
  `/boss tower`, `call_tower` from a main. A sidecar's `call-tower` asks the same endpoint. Against a stopped server only `/boss tower`
  succeeds (**Stopping**).
- `ensure-tower` makes the tab the way `ensureTower` does today (reusing a marked or bare tower tab, moved first, labelled with the
  glyph). Its shell gets no Straw Boss environment, since a Herdr restore would drop it anyway. The server marks the pane `sb_role=tower`,
  registers the tower identity with `herdrPaneId` = the standing pane and the identity's own cwd, registers `straw-boss/control` for it,
  and writes the workspace token `tower` and `service.json`. It starts no pi. It answers within about 2 s, against up to 60 s today,
  since no pi has to start.
- A sub workspace still has no tower. `ensure-tower` for one answers with its parent's tower, as today.

### A workspace loses one

- The boss closes the tower: the tower card's close button, `/boss close` aimed at the tower, or the tab closed in Herdr. The service then
  ends its runs, deregisters the identity, clears its tokens, writes `sb_tower_quit=<members it left>` as a quitting tower does today,
  deletes `service.json`, and keeps the queue for 24 h. A tower reopened in that time gets it, and the brief says how old each event is.
- A run that exits is not the tower quitting. Its pane returns to the shell, and the tab and the identity stay.

### A Herdr restart

- A new Herdr server (a restart, or a restore after a reboot) has no pane tokens and no pane environment. The server sees the takeover on
  its events connection and, for each `service.json`, finds the tower tab again: by the recorded tab and pane id when Herdr kept them,
  else by the tower glyph label with a single pane in that workspace. It marks the pane again and republishes the `tower` token.
- Runs that were live are ended in the records (outcome `herdr-restart`), and their taken events go back to the queue with the crash
  flag (**Crash and timeout**). Herdr's pi integration may resume their pi in the restored panes. Such a pi is quit at its start
  (**The wake protocol**, step 2).
- The next event wakes a fresh run in the restored standing pane. A test does exactly that (**Tests and anchor**).

### State

`tower/<workspace id>/` in the server's slot (mode 700, files 600, each written by rename):

- `service.json`: the identity id, the standing pane and tab, when it was created, and the next event sequence number.
- `queue/<seq>-<event id>.json`: one queued event (**Queueing and concurrency**). `queue/parked/` holds events parked after crashes.
- `seen.jsonl`: the intercom messages taken, for dedupe (**Queueing and concurrency**).
- `runs/<run id>.json`: kind (`local` or `ally`), the device and level for an ally run, pane, pi PID and start time, Herdr agent name,
  session file, started, ended, outcome (`done`, `timeout`, `crashed`, `quit`, `herdr-restart`), and the event ids it took. The last 50
  are kept.
- `notes.jsonl`: handoff notes, local ones and each device's ally ones apart, the last 10 of each.
- `opened.json`: the opener's ledger (sender, request hash, outcome, tab, main), 24 h.
- `awaiting.json`: asks sent for a main (**Replies for a main**), 24 h.

`link/threads/<device id>.jsonl` (primary server only; mode 600, in the 700 `link/` folder) is each ally device's thread (**The brief**).

## Wake triggers

An event wakes a run. Everything else is shown in the GUI or handled by the server alone.

| Source | Becomes | Run |
|---|---|---|
| An intercom message to a tower identity: `call_tower`, `tower_send` from another tower, a `boss_broadcast` with scope `towers`, a main's done report, a reply to something the tower sent, a plain `intercom send` | Event `intercom`, with the text as received (its code-written header included) and the broker's sender line | Local |
| A Straw Link `tower` envelope routed to this workspace (**Delivery**, Straw Link spec) | Event `link`, through the inbox as today | Ally (**Ally runs**) |
| The boss types into the tower from the GUI while no local run is live | Event `boss`, the text verbatim | Local, queued ahead of the rest |
| The boss types `/boss tower <prompt>` in any pi session of the workspace (D15) | Event `boss`, the prompt verbatim, through the same server endpoint as the GUI composer | Local, queued ahead of the rest |
| An outcome of something a local run sent that arrives after that run ended: an intercom delivery that failed, a main opened by the opener that failed to start, a `close-main` that timed out, a relay refusal after "queued" of a send from a local run | Event `notice`, written by the server | Local |
| An outcome of a send an ally run made (a relay refusal after "queued", a delivery that failed) | Event `notice` in that device's ally queue | That device's next ally run |
| `tower_done({ wakeAfter })` from a local run asked for a follow-up, 5 to 240 minutes (D3) | Event `timer`, one pending per workspace: a later `wakeAfter` replaces it, since the latest run knows best what is still open | Local |

These do not wake a run:

- Presence, `board`, and `caps` envelopes (they never start a turn, as before).
- A `confirm-request` from an ally's gate at `forward`: it is the boss's to answer in the GUI's notices, as today (D5). A
  `confirm-answer` goes to the ally run waiting for it.
- A join request, a roster mismatch, the relay unreachable: these are GUI notices for the boss.
- Herdr events and state changes of mains: the tower reads them in the brief when something else wakes it.
- An ally's `tower-reply` to an ask made for a main (D4): it goes to the main that asked, with no run (**Replies for a main**).

**What "send" means (D2).** The boss's "不管是接收還是送出" means two things. First, the result of a send the tower made comes back
after its run ended: the `notice` rows above, and replies, which arrive as `intercom` events. Second, the boss asks the tower to send
something: the `boss` row. A send on its own wakes nothing.

## Queueing and concurrency

- **One local run per workspace at a time.** Workspaces are independent, so two workspaces may each have a local run. The server runs at
  most `towerRuns.max` pi runs at once across the machine (default 4, `config.json`), and the rest wait in their queues.
- **Ally runs** go in an ally pane beside the local run, one ally run per workspace at a time (D6).
- **Ordering.** Within a workspace, events go in the order the server received them, except that `boss` events go first. For each
  local event the broker's message id is kept, and for each link event the envelope id.
- **Persistence.** The server registers each tower identity with `acknowledgesReceipts` and only after its queue store is open. It reads
  each message off the socket, writes it to `queue/` with an fsync, and only then sends the receipt `queued`. A link event stays in
  `link/inbox/` until a run takes it, as today. While the server is down, mail to a tower identity waits in the broker's mailbox: in
  memory, for 24 h, and within the broker's cap of 256 messages for every session together, past which the oldest is evicted with nobody
  told (**Reality anchor**). A broker restart while the server is down loses that mail. This holds because every Straw Boss message is a
  `send`, never a blocking `ask`. A sender using pi-intercom's `ask` to a tower identity that is down gets `E_TARGET_DISCONNECTED`, as for
  any session that is gone.
- **Retrying sends to a tower.** The broker never sends again by itself, and the outbox cannot say whether an outcome is unknown
  (**Reality anchor**). So Straw Boss's sender retries **every** failed send whose target is a tower identity (`sb-tower-*`), whatever
  the reason, `E_TARGET_NOT_FOUND` included (a broker that started after the server went down has never seen the id). This is `send` in
  `src/reach.ts`, used by `call_tower`, `tower_send`, `boss_broadcast`, the opener's handoff, and the server's own sends.
  - It retries for up to 30 s, the restart budget, each time the identity is live again or after 2, 5, 10, and 20 s.
  - pi-intercom's outbox refuses a request id it already used, so a retry goes under `<request id>~r<n>`, with `n` up to 4.
  - The dedupe below makes a retry safe, also when the first try was in fact taken.
  - A plain `intercom send` from another agent is not retried by Straw Boss: pi-intercom tells that agent the delivery failed, and it
    decides.
- **Dedupe.** `seen.jsonl` keeps, per taken message, the sender id, the base message id (a retry's `~r<n>` removed), and the SHA-256 of
  its text. Entries are kept 48 h, longer than the broker's mailbox, and at most 5,000 per workspace, oldest out first.
  - A message whose sender, base id, and hash are already there is not queued again, and still gets its `queued` receipt, so the sender's
    retry ends.
  - The same base id with another hash is not a retry. pi-intercom refuses an exact id reused with other content, but `x~r1` is a
    different id to it. Such a message is dropped and logged, since Straw Boss's sender never does that.
  - An envelope id is taken once (the inbox and the sender's sequence mark already ensure this). A `notice` has an id derived from what
    it reports.
- **Mail flushed from the broker's mailbox when the identity registers** is marked delivered at once, with no receipt, so a crash while
  the server writes that batch loses it with nobody told. The server keeps the window small: the batch is the first thing it reads after
  registering, written before anything else is done. The gap is in pi-intercom, so B5 proposes an upstream change: a mailbox flush to an
  `acknowledgesReceipts` session waits for each receipt and puts unreceipted mail back in the mailbox when that session disconnects.
  Until that ships, it is a documented limit (**Risks**).
- **Coalescing.** A wake waits 1 s after the first event, so a burst starts one run with all of it.
- **Events while a local run is live** go to that run, at the next moment it is idle (`isIdle()` and no pending message, checked in the
  same tick, as `pump` does). Each one goes as one custom message `straw-tower` with `triggerTurn`, and the run reports it `taken` once it
  is in the session. An event offered but not taken returns to the head of the queue when the run ends.
- **Events while a run is closing** (after `tower_done` was accepted) wait for the next run, which starts 1 s after the pane is back at
  its shell.

## The wake protocol

1. **Start.** The server checks `towerRuns.max`. It runs `assertSettingsSafe([dir])` on the standing pane's cwd (else the workspace's
   checkout path) before every run, local and ally, and runs nothing when the check refuses: the events stay queued, the tower card shows
   the refusal as an error notice, and the next attempt comes with the next event, at most once a minute.
   - **A local run** starts in the standing pane: `startPi(run, sleep, "tower-<ws>-<run8>", pane, ["--name", "tower run · <label> ·
     <run8>", "--sb-run", "<run id>", ...towerModel])`, where `<run8>` is the run id's first 8 hex.
   - **An ally run** first splits the tower tab (`pane split`, no focus) and starts pi there under `ally-<ws>-<run8>`, named `ally run ·
     <device label> · <run8>`.
   - Every run has a name of its own. The broker treats a name and cwd as one mailbox identity, so a run named like the tower identity
     would take its mail while the identity is down (**Reality anchor**). The identity's cwd is a folder no pi runs in, which keeps the
     two apart even for a run the boss starts by hand.
   - `waitPastTrust` covers a project trust question, as for any tower today.
2. **Claim.** Straw Boss registers the flag `--sb-run` (`registerFlag`). A pi started with it asks the server to `claim {runId, pane,
   pid, started}` over the control socket at `session_start`, before it joins anything. The flag is how a run knows it is one: pane
   environment and pane tokens do not survive a Herdr restore (**Reality anchor**). The server checks that:
   - the run id names a run it started and has not ended;
   - the PID and start time are the ones the server recorded for that run. Right after `startPi` the server reads the run's pi PID with
     `herdr pane process-info` and its start time with `startOf`, and writes them to `runs/<id>.json`; a claim that comes before that is
     held (answered `wait`, retried each second for 10 s);
   - the server has processed every Herdr takeover it has seen (**A Herdr restart**). Until then every claim is held the same way. A pi
     that Herdr's pi integration resumed with `--sb-run <old id>` therefore meets a run that is already ended, or a PID that does not
     match, and its claim is refused;
   - the run has not been claimed already. One claim per (run id, pane, PID, start time); a second claim is refused, and the pi that
     made it quits.

   It then answers with a run token (random, kept in memory only), the run's kind, its level, and the brief. A pi with `--sb-run` whose
   claim is refused quits at once with the reason.
   - **A pi without the flag** in a pane the server lists as a standing or ally pane asks `pane-role {pane, pid}` at `session_start`,
     before it joins. A pi in a tower glyph tab whose server is not live waits up to 30 s for one before it joins. The server answers:
     - `quit` in an ally pane: only the server starts pi there.
     - `quit` in a standing pane that held a live run when Herdr went away, for 2 minutes after the restart. That is Herdr's pi
       integration resuming the old run, whatever its session file holds.
     - otherwise, in a standing pane, `hand`: the boss started pi there by hand. It becomes a local run with the brief and no events, gets
       its own run id and token, and ends on `tower_done` like any run.
3. **Run.** The run's Straw Boss is in run mode. It does not join a tab net, publish tokens, run the guard, look at the server, or hold
   a link role. Its bridge relays its dialogs as in any session. It registers the tower tools (**Tower tools in a run**) and blocks
   pi-intercom's `intercom` tool, pointing to `tower_reply`. It puts the brief in its system prompt's role section, and sends the claimed
   events as `straw-tower` messages in order. The first one triggers the turn.
4. **Done.** The run calls `tower_done({ note, wakeAfter? })`.
   - `note` is required, 1 to 1,200 characters, one item per line, and is cut and cleaned like a board entry.
   - `wakeAfter` is taken from local runs only; an ally run's call with it is refused, since a peer-steered run must not schedule a local
     wake.
   - If the server has events offered to the run but not yet taken, or new ones queued for it, it refuses with "N events still for you"
     and offers them.
   - Otherwise it records the note, clears the digest lines the brief showed (a local run only), marks the run `closing`, and answers.
     The run's extension then quits pi (`ctx.shutdown()` after the tool result is written).
   - A local run's standing pane is back at its shell. An ally pane is closed by the server (`pane close`) once its pi has exited, since a
     pane that pi leaves returns to its shell and would otherwise stay.
   - The service is `standing` again, or wakes the next run 1 s later if events came in meanwhile.
5. **Handoff.** The note goes into the next run of the same kind: a local run's note to the workspace's next local run, an ally run's
   note to the next ally run of the same device. Nothing crosses between the two.

### Crash and timeout

- **Idle without done.** A run that settles idle with nothing pending and no `tower_done` gets one steer after 60 s: "call tower_done
  with your handoff note". After another 5 minutes idle the server ends it (`quit` over the socket) and writes the note
  `(ended without a note)`.
- **Too long.** At 18 minutes a run gets a steer to wrap up and call `tower_done`. At 20 minutes (D12) it gets `quit`. The tower never
  waits on work: a main's result comes back as a new event. So a long run is a fault, and the cap keeps a stuck run from holding the
  queue.
- **Quit fails.** If pi has not exited 10 s after `quit`, the server sends Escape and `/quit` through Herdr, then SIGTERM to the PID read
  from `herdr pane process-info`, never one from a record alone.
- **Crash.** The pi exits without `tower_done`: its socket closes and Herdr reports the pane at its shell or the agent gone. Its offered
  events go back to the queue. Its taken events go back too, flagged `possibly handled by a run that crashed: check before acting` in the
  next brief, so delivery is at least once. The note is `(crashed)` with the last outcome. The digest lines it was shown stay for the next
  run, since only `tower_done` clears them.
- **Poison events.** An event that was taken by two runs that both crashed or timed out is parked in `queue/parked/` and no longer
  offered. The tower card shows a notice with its kind, sender, and first line, and **Deliver again** or **Drop**.
- **Crash loop.** Three crashed or timed-out runs in 10 minutes stop the service's waking. The tower card shows an error notice with the
  last run's tail (20 lines of `herdr pane read`) and the log's path. The queue is kept. The next `boss` event, or **Retry** on the
  notice, wakes again; parked events stay parked.
- **Server restart during a run.** See **Restarts and upgrades**. A run that does not reconnect within 30 s is treated as crashed once the
  new server sees its PID gone, or as orphaned if it is still alive: it gets `quit`.
- `/new`, `/resume`, or `/fork` in a run end its claim: the server records outcome `quit`, and the next event wakes a fresh run. A
  `/reload` keeps the claim (same process, same pane, same flag).

## The brief

The brief is plain text in the run's role section. It is built by the server, never by a model, and has a hard cap: **6,000 characters**
for a local run and **4,000** for an ally run. Each section has its own cap, and a cut section says how much it left out.

Local run, in this order:

1. **Who and why** (≤ 300): `You are a run of the tower of workspace <label> (<id>); head tower: <label>. Woken <HH:MM> by: <n intercom,
   n boss, n notice, n timer>. Your identity for replies is sb-tower-<ws>; everything you send leaves under it.`
2. **Mains you supervise** (≤ 24 rows, each ≤ 200): per tab of the workspace, the main's name, short session id, state (`idle`,
   `working`, `waiting`, `commanding`), whether a tower opened it (and for whom), and its board `now` with its open item count. Members
   are counted per tab and not named. A tab with no main says so. These are the same data as `board_read`'s `local` and the dashboard.
3. **Open obligations** (≤ 10 rows): from the opener's ledger, the run records, and `awaiting.json`. Mains this tower opened that have
   not reported, mains that reported done and wait to be closed, sends that expect a reply and have none, asks for a main still open,
   and a `wakeAfter` that is due.
4. **Since your last run** (≤ 20 lines of 80): the digest, read from the `sbd_` tokens. It is cleared when the run calls `tower_done`,
   not at claim, so a run that crashes does not lose it.
5. **Handoff note** (≤ 1,200): the last local run's note, with its age.
6. **Tools** (fixed text, about 900): one line per tower tool (**Tower tools in a run**), ending with "Call tower_done with a handoff
   note when nothing is left for you."
7. **Flags**: events flagged by a crash, and the run cap (20 minutes).

The events are not part of the brief. They arrive as messages, each with the header it came with.

Ally run: section 1 names the sender (label, short id, team, level), with no head tower and no identity. Sections 2 and 3 are replaced by
what the run's sender may already see. That is the `tower_list` and `board_read` scope of a remote turn: only workspaces inside the
project the sender's team binds, and only that team's boards. Section 4 is left out (the digest is local). Section 5 is that device's
last ally-run note. Section 6 lists the tools the level allows. Added:

- **Asks in this run** (≤ 5 rows): for each envelope of the run that carries `awaitsReply`, its ask id and first line, so the run can
  answer it by `inReplyTo` (**Replies for a main**).
- **Thread with this device** (≤ 1,500): the last 6 messages of the device's thread, each cut to 240 characters, under the note that
  they are peer text.

**The thread store.** The boss decided: "存，每台裝置最近 20 則、留 7 天".

- The primary server keeps one file per ally device, `link/threads/<device id>.jsonl`, mode 600 in the 700 `link/` folder. It holds both
  directions: what the device sent this computer's towers (`tower`, `tower-reply`) and what they sent it.
- One line per message: direction, time, envelope id, kind, `awaitsReply` or `inReplyTo` when set, and the text cut to 4,000 characters.
- It keeps the last 20 messages and none older than 7 days, pruned at each write and on the holder's purge tick.
- The file is deleted when the device leaves the roster (removed, or it left) or this computer leaves the team.
- It is peer text at rest on this computer, within the folder that already holds the inbox and the team keys. No tool reads it. Only the
  brief builder does, and only for that device's ally runs.

## Tower tools in a run

Every tower tool in a run is a thin client of the server over the control socket, authenticated by the run token. The server enforces
the run's kind on every request, in addition to the hooks in the run.

| Tool | In a local run | In an ally run |
|---|---|---|
| `tower_list`, `board_read` | The full answer, as today | Scoped to the sender's team, as in a remote turn today |
| `boss_status`, `call_tower` | Inside the workspace, as today | `boss_status` only (allowlisted) |
| `tower_send` | Sent by the server as the tower identity, with the header the server writes (`id=sb-tower-<ws>`, `role=tower`, `head=yes` when it is). With `device`, `reply: true`, and `for: <local session>`, it is an ask for a main (**Replies for a main**) | Only to the sender's device; `inReplyTo` answers one of the run's asks. Any other target needs the gate, and the server checks the gate's Allow (below). A target that is a tower identity of this machine is refused outright, since it would carry peer text into a local run. |
| `tower_reply` (new) `{ to, message, reply? }` | One message to one local session by id or name, sent as the tower identity under the header. This replaces "answer with intercom send". | Gate, as for `tower_send` to a local target. `origin=remote:<device id>` is stamped by the server. |
| `boss_open_main`, `boss_close_main` | Run by the server with the persisted ledger and limits; `close-main` goes out from the tower identity | Gate (dispatch: allowed) |
| `boss_server` | As in any local session (**Seeing and restarting the server**) | Refused by the token's kind, at every level |
| `link_request` | Unchanged (the boss approves) | Refused at every level, as today |
| `tower_done` | Ends the run | Ends the run; `wakeAfter` refused |

**The gate's Allow, checked by the server.** For a gated call from an ally run, the run sends the server the call's `toolCallId` and the
SHA-256 of its canonical arguments, with its token. The server takes it only when the hub holds an Allow for the gate dialog of that
`toolCallId`, opened by this run's token, over arguments with that digest, and not yet used. The Allow is then used up. A second call
with the same id, other arguments, or another run's token is refused.

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
- At `dispatch` (an unattended device's controller) the run has the full tower tools of a local run, minus `link_request`,
  `boss_server`, and `wakeAfter`, and keeps the device's own guards.
- **No tower service for the team's project.** On an attended device, a link message for a project in which no workspace has a tower
  service waits in the inbox for 7 days with a GUI notice, as today. The server opens nothing for it; the boss opens the workspace, or a
  promotion opens its tower, and the message then gets its ally run. Only an unattended device opens a workspace for a controller
  (**Unattended devices**).
- A `confirm-request` from an ally's gate at `forward` stays a GUI alert for the boss and wakes nothing (D5).
- The Straw Link spec's rule "an attended device never opens a tab or a session for a remote message" is amended by the boss's
  decision D1: an attended device opens a session, an ally run in the tower tab of a workspace it already has, never a tab or a
  workspace (**Addressing and delivery**, Straw Link spec, amended in the same change).

### Replies for a main (D4)

A local tower often asks an ally on a main's behalf. Under "every ally message gets its own session", the answer would reach an ally
run with no local context, and passing it on to the main would need a gate confirm every time. So the local tower names the asker, and
the reply goes to that main. Three things keep it working in a team where some devices run an older build, and keep two asks apart.

**Capabilities first.** A field added to `tower` would make an older receiver drop the whole message, and a new kind is dropped by an
older receiver and refused by a relay that lacks it (**Reality anchor**). So:

- A new ephemeral kind `caps` (whole team, any member, like `board`) lists what a device takes: `tower.awaitsReply` and `tower-reply`.
  The holder sends it at each stream start, when its build changes, and once an hour. An older client drops `caps` as `unknown-kind`
  and keeps working, as with `board`.
- A `caps` older than 2 h counts as none. The relay keeps a device's last `caps` after the device downgrades to a build that sends
  none, and an asker that trusted it would send 5-field `tower`s that the old build drops as `bad-plaintext` with nobody told; an hourly
  `caps` from a current build keeps it fresh.
- `tower` gains an optional fifth field, `awaitsReply` (an ask id, 16 random bytes in hex). This build decodes `tower` with 4 or 5
  fields. A sender writes the fifth field only to a device whose last `caps` lists `tower.awaitsReply`. To any other device the ask
  goes as a plain 4-field `tower`.

**Asking.** `tower_send({ device, workspace?, text, reply: true, for })` in a local run. `for` is a live local session (id or name) that
is a main of the tower's workspace.

- The server makes an ask id and records `{ ask id, envelope id, device, for: <session id>, expires: 24 h }` in
  `tower/<ws>/awaiting.json`.
- It sends `tower` with `awaitsReply` when the device's `caps` allow, else a plain `tower`, and says which in the tool's answer.

**Replying.** The ally run sees each ask in its brief and in its event header (`asks=<ask id>`).

- It answers one with `tower_send({ device: <asker>, text, inReplyTo: <ask id> })`. `inReplyTo` must be the ask id of one of this
  run's envelopes; any other value is refused. Two asks from one device in one run are answered apart, each by its own id.
- The server sends kind `tower-reply` (`inReplyTo`, `text`) when the asker's `caps` list `tower-reply`. Otherwise, and when the relay
  refuses the kind (`unknown-kind`), it sends a plain `tower` with the same text and logs the fallback once per device and hour.
- A `tower_send` without `inReplyTo` is a plain `tower`, as today.

**Taking a reply.** The asking server takes a `tower-reply` as a reply only when all of these hold:

- `inReplyTo` names an open ask;
- the envelope comes from that ask's device;
- the ask has not been used.

It then closes the ask. Anything else (no ask, wrong device, used, expired) is treated as a plain `tower` message and gets an ally run.

**Delivery to the main.** The reply reaches the main as peer data, by the path a tower took a delivery by in step 3:

- the server offers it over `straw-boss/link`;
- the main takes an offer only from the server's `intercomId` and holds it until it is idle;
- it then sends it into its session as a `straw-link` custom message with `triggerTurn`, under the verified header plus
  `kind=link_reply` and `for=<tower>`.

No run starts and nothing enters a tower. That main's run is then a remote turn at the replying device's level, with the step-4 hooks
(**Security**). If the main has gone (not live, or no longer the tab's main), the reply falls back to an ally run, whose brief says which
main asked.

**Mixed builds.** An ask to an older device comes back as a plain `tower` and gets an ally run, and so does an ally's reply to an older
asker. Nothing is dropped.

**In lockstep with the relay and the Straw Link spec.** As `board` was added in 5b:

- `src/link/kinds.ts` gets the rule rows `caps: { ephemeral: true, wholeTeam: true, sender: "any" }` and `tower-reply: { ephemeral:
  false, wholeTeam: false, sender: "any" }`, their plaintexts, and the 4-or-5-field `tower` decode.
- `tests/link/vectors.json` gets both kinds, the 5-field `tower`, and their invalid cases.
- straw-relay gets the same two rule rows in `internal/link/kinds.go`, a copy of the vectors in `testdata/vectors.json`, and the commit
  pointer in its README moved to the client commit the copy came from. Its `vectors_test.go` fails when its kind count differs from the
  vectors, so the two cannot drift apart unnoticed.
- The relay is redeployed with the two kinds before the client release that sends them. Until then a client still works: `tower-reply`
  is refused with 422 `unknown-kind` and falls back to `tower`, and a refused `caps` is logged once and left alone for an hour, as
  `board` is.
- The Straw Link spec's **Message kinds** table gets the two rows and the `tower` row's optional fifth field, and its plaintext sentence
  says that plaintexts decode strictly, so a field is added only behind `caps` (amended with this revision).

## Security: Remote turns after the split

**Stays as built in step 4 and 5b:**

- Trust levels and where they come from (`link.trust`; the unattended policy file and its owner check; `reply` by default).
- The allowlist: `read` of tracked files; `grep`, `find`, `ls` inside the project with the `tool_result` filter; `tower_list` and
  `board_read` scoped to the senders' teams; `boss_status`; `todo`; `tower_send` to the sender.
- The deny list, refused outright for any tool's path arguments.
- The gate (owner `straw-link-gate`, keyed by `toolCallId`, full arguments up to 12,000 characters, 10 minutes, terminal and page, first
  answer wins) and `forward`'s `confirm-request` and `confirm-answer`.
- `link_request` refused at every level, and now `boss_server` too.
- The verified header for the first message (`id=link:<device>`, label character set, `team=` from this computer).
- `origin=remote:<device id>` on everything an ally run sends to a local session. The server stamps it now, not the run.

**Simplified for towers, because a peer's message never shares a tower session with local context:**

1. Run classification (`turn.ts`: from a `straw-link` `message_start` or `message_end` to `agent_settled`, the lowest level of several
   senders) is replaced by the run's kind and level, fixed at claim for the whole session. There is one sender per run.
2. Holding a delivery until the tower is idle, and the 10-minute "waited for an idle tower" notice, are gone for ally runs: the session
   starts with the message. The server raises the notice instead when an ally message waits more than 10 minutes for an ally run slot.
3. `hideOldRemote` and the `context` marker for older peer text are not needed in towers: no local run ever receives a peer's message.
   A test checks that a local run never receives a `straw-link` or `link` event. Allies' board text and presence labels still enter
   local runs through `board_read` and `tower_list`, as since step 5b: under `origin: "remote"`, cut to 120 characters a line, below the
   note that they are data. That limit stands as documented there.
4. The documented compaction limit (a peer's text surviving unmarked in a summary) does not apply to a peer's messages in towers: an
   ally session holds the brief and peer text only.
5. The documented `origin=` limit for pi-intercom's own tool after a gate approval is gone in towers: runs cannot use that tool, and the
   server stamps `origin=` on every send.
6. In towers, the `straw-link-seen` session entry is replaced by the run records' taken ids.
7. "A steer into a run that began local makes it remote" can no longer happen in a tower: a link event is never offered to a local
   run.

**Reopened by D4, for mains only.** Step 3 sent link deliveries to towers only, so only towers needed the gate (review R-F003 of
2026-10-25). A reply for a main puts peer text into a main, which runs at full rights. The boss confirmed it ("照 D4 直送，那一輪 main
套用遠端規則"). The step-4 machinery therefore stays, scoped to mains that take such a reply:

- run classification from the `straw-link` message to `agent_settled`;
- the allowlist, the deny list, the gate, and `forward`;
- `link_request` and `boss_server` blocked;
- `hideOldRemote` in later runs;
- `straw-link-seen`;
- the documented compaction limit;
- the documented `origin=` limit: a message the main sends through pi-intercom's own `intercom` tool after a gate approval carries no
  `origin=` header, since mains keep that tool.

It is bounded: only a reply, only from the device asked, once, to the main the local tower named, within 24 h. The remote-turn hooks
stay registered in every joined session, so this needs no new hook code. B6 gets a fresh-context security review for it.

**New guards:**

- The server enforces the run token's kind on every control request (the table above). An ally run cannot message a tower identity of
  this machine, restart the server, or schedule a local wake.
- A gate's Allow is tied to the run token, the call id, and the arguments' digest, and is used once (**Tower tools in a run**).
- An ally run's `context` event drops any pi-intercom message, as a backstop. The run's own intercom id is fresh, and no header names it.
- Every control connection opens with the `hello` secret, and on Windows the state directory carries an owner-and-SYSTEM ACL checked by
  SID (**The control socket**); a pipe's name and a file mode protect nothing there. Run tokens are held in memory only, so reading
  `server.json` gives no run's privileges.

## Unattended devices (Straw Link step 6, rebased)

- The infra runs `herdr server` and `cli.mjs serve` (launchd with `UserName`, or a systemd user unit with lingering), both under
  `env -i`, with Herdr on its default socket so the server is the primary one. It no longer needs a boot pi session to hold the link,
  since the server is the holder.
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
- **Notices**: a refused settings check, a crash loop with **Retry**, a parked event with **Deliver again** and **Drop**, an ally
  message waiting more than 10 minutes, a server stopped on purpose that an automatic opening found, and a server `lastError`.
- **The server** in the settings panel: state, version, uptime, last error, **Restart server**, and **Show log**, on this computer's
  page only (**Seeing and restarting the server**).
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
contract) is the server's intercom id. These paths are the primary server's, the one for the default Herdr (**One per state directory
and Herdr server**); straw-boss-desk runs its Herdr on the default socket of its own `HOME`, or sets `HERDR_SOCKET_PATH` to that path.

**What changes for a reader.**

- **Gone** no longer depends on a pi session surviving. A server that went down without a stop is started again by the next pi session's
  look (within about 6 s while any pi runs) or by its supervisor. With no pi session and no supervisor it stays down until something
  starts it, which the shell now does itself with `cli.mjs up`.
- `stopped` in `gui.json` now means that the GUI listener was stopped on purpose (`/boss gui stop`). The server goes on running the
  tower services and the link. The whole server stopped on purpose is `server.json`'s `stopped`. `up` and `serve` clear both.
- A restart or upgrade keeps the port and token (**Restarts and upgrades**), so the shell's webview reconnects without reading anything.
  Moved is the only case in which the shell reads a record again.

**The successor: `server.json`.** It sits beside `gui.json` and describes the stack, not only the page. The shell may read `pid`,
`started`, `version`, `herdr`, `mode`, `desk`, `stopped`, `restarting`, `lastError`, `log`, and `gui: { port, token, stopped }`.
`socket`, `secret`, `intercom`, and `intercomId` are for sessions and runs only, and like the token the file is a secret, never logged.

**On the happy path the shell reads no file at all.** `cli.mjs up` prints everything it needs (**`up`'s output**), and `cli.mjs status`
prints the state below as one JSON line. Files are for watching between launches, and `cli.mjs logs` for debugging.

### States for a shell

`restarting.since` is touched every 2 s by the server that is starting (**Starting**), so a restart counts as under way only while that
touch keeps coming, however long the start takes; there is no fixed overall limit.

| State | How to tell from the files | `cli.mjs status` | What the shell does |
|---|---|---|---|
| live | `server.json` has no `stopped` and no `restarting`; its `pid` is alive and started at `started`; a GET of the URL answers 200 | `{"state":"live", …}` | Show the page. |
| moved | live, but `gui.port` differs from the URL the shell loaded | `live`, with the new `url` | Load the new URL once it answers 200. The token stays. |
| restarting | `server.json` has `restarting` whose `since` is within the last 10 s | `restarting`, with `reason` | Keep the page; its stream reconnects on the same URL. |
| gui stopped | live, and `gui.stopped` (`gui.json`'s `stopped`) is set | `gui-stopped` | Say the GUI was stopped; `up` starts it again. |
| server stopped | `server.json` has `stopped` | `stopped` | Run `up` at the next launch (it clears `stopped`). |
| gone | none of the above: the PID is dead or started at another time, or `restarting.since` is older than 10 s, or the URL has not answered for 10 s while nothing touched `since` | `gone`, with `lastError` and the `start-error.json` reason when there is one | Run `up`. |

**Migration**, in three releases that the shell pins one at a time:

| Release | `gui.json` | `server.json` | The shell |
|---|---|---|---|
| S1 (the server ships) | Written by the server, contract unchanged | Written, documented as the successor, with `up`, `status`, and `logs` | Nothing has to change. It may use `cli.mjs up` instead of waiting for a pi to host the GUI. |
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
| S5, `desk up` | **Replaced by `cli.mjs up --dir <folder> --label <name> [--timeout s] [--exact]`** at the path of **What the server runs from**. Steps: `herdr`, `integration` (S6), `version`, `server` (start, find, restart for the switch, or upgrade), `base` (`desk.json`, as specified), `tower` (`ensure-tower`, no pi, no 90 s restore wait: a restored run is quit rather than kept), `gui` (the URL answers). With `--dir`, `up` refuses with exit 2 when the switch is missing, as specified. Without `--dir`, `up` only makes sure the server runs. |
| S6, Herdr's pi integration | Stays, installed by `up`. |
| S7, S8 | On `main` (R1). The detached start adds `windowsHide` too (**Starting**). |
| S9, hidden features | Stays. The server reads the switch and tells the page. |
| S10, native folder dialog | Unchanged (the page and the shell's preload). |
| "Out: a GUI server that runs without a pi session" | Reversed by the boss's decision above. |
| Stopping the stack | straw-boss-desk runs `cli.mjs stop` when it quits, then `herdr server stop`. Its next launch runs `up`. |

For the shell, `start.ps1` and the macOS kit become: start `herdr server` with the switch, run `cli.mjs up`, and record PIDs. A cold
Windows start no longer waits for a tower pi (66 s measured) before the page answers; B1 measures what it takes instead (budget 15 s).

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
  "log": "/Users/…/straw-boss/server.log",
  "steps": [{ "name": "herdr", "ok": true, "ms": 40 }, { "name": "version", "ok": true, "ms": 3 }, { "name": "server", "ok": true, "ms": 1200, "detail": "restarted: desk switch" }],
  "warnings": [{ "code": "server_newer", "text": "the server runs 0.46.0, this package is 0.45.0" }],
  "workspace": "w_…", "pane": "p_…", "tower": "sb-tower-w_…", "created": false, "integration": "current"
}
```

- `url` is `null` until the GUI moves into the server (B2): B1's server serves no page, so `up` and `status` have no URL to print, and the
  `gui` step is absent. B2 fills `url` in (`status` has it too, from the record's `gui`).
- `version` is the live server's, and `package` the version of the package `up` ran from.
- `steps` lists every step that ran, in order: `herdr`, `integration` (with `--dir`), `version`, `server`, then `base`, `tower`, and
  `gui` with `--dir`, or `gui` alone without it.
- `warnings` codes: `server_newer`, `desk_on` (a desk server found by an `up` without the switch), `remote_off` (remote access did not
  resume, with the reason), and `integration_installed`.
- The last five fields come only with `--dir`.
- Exit codes:
  - 0: done.
  - 1: a step failed. One JSON line `{ "step", "reason", "steps", "warnings", "log" }` goes to stderr. A `gui` failure adds the log's
    last 20 lines. A record on another Herdr socket than the slot's fails at `herdr`, and `--exact` against a newer server at `version`.
  - 2: usage, or `--dir` without the switch.
  - 3: the server cannot run: `start-error.json` says `loader` (`tsx` not found) or `acl` (the Windows ACL could not be set or did not
    check out). The reason and the SDDL read go into the stderr line.
  - 4: from `serve` only, a live `serve` server already runs.
  - 5: from `stop` only, the server is a `serve` server (stop its supervisor).
- A second `up` while one runs waits for it on `server.lock` (up to `--timeout`), then reports what it finds.

## Migration from resident towers

All of it is behind the flag `towerRuns.enabled` (**Build steps**). With the flag off, a resident tower stays resident and nothing is converted.

- When the server first runs with the flag on, a live resident tower (an older pi holding the workspace's `tower` token) keeps its
  workspace. The service waits and registers its identity only once that session leaves. Two towers never hold one workspace.
- A new-code pi started as a resident tower (`STRAW_BOSS_ROLE=tower`, or `roles/` says tower), for example opened by an older session's
  `ensureTower` or resumed by a Herdr restore, asks the server for `ensure-tower` on its workspace and quits once the server has written
  the `tower` token for the identity. Its tab becomes the standing pane's tab. A message sent to that pi's own id after it quit waits in
  the broker's mailbox for an id that never comes back, so the hand-over happens at the pi's start, before any agent learns its id.
- `roles/` records with role `tower` are converted into `service.json` and then deleted. Main records are untouched.
- The `straw-boss/link` channel keeps serving requests from sessions of the previous build, and carries the server holder's `offer`s
  to resident towers (`src/link/runtime.ts:154`, `:342`), for as long as `towerRuns.enabled` exists: with the flag off, towers are
  still resident and take link mail that way. Once the flag is removed (the release after B6), the channel carries only the server's
  offers of replies to mains (**Replies for a main**).

## Build steps

Inserted before Straw Link step 6, which is rebased on them. Each step passes `npm run check` and `npm test`, updates
`docs/how-it-works.md`, and is merged on its own. B4 to B6 sit behind one flag, `towerRuns.enabled` in `config.json` (off by default), so a
release between them never leaves a tower that takes no events or link mail with no taker. The flag goes on by default, and is then
removed, with the release that carries B6.

1. **B1, server skeleton.**
   - `src/server/{main,cli,record,socket,log}.ts`, built to `dist/server/*.mjs` by `prepack`, with the build's check that the bundle has
     no value import of pi-tui, typebox, or pi-coding-agent.
   - `tsx` as a runtime dependency, loaded only for pi-intercom's client through scoped `tsImport`. An upstream request to pi-intercom for
     a JavaScript build.
   - `server.json` and `server.lock` (holder recorded, taken over only when dead or past 120 s), the per-socket slots and their identity
     ids, and `start-error.json`, cleared at each start attempt and on `hello`.
   - The control socket or named pipe with the `hello` secret, and the Windows ACL set and checked by SID.
   - Liveness, `restarting.since` touches, and the detached start from a session's look, with `windowsHide`, the kept scope and
     transport, and the version and `restarting` rules.
   - `serve` (with its take-over), `up` without `--dir` (with `server`, `version`, and desk handling), `stop` (refused for `serve`),
     `status`, `restart`, and `logs`.
   - The restart path that keeps the port and token, with the requester holding `server.lock`, and `upgrade`.
   - `server.log` with rotation, `lastError`, and `boss_server` and `/boss server`.
   - The intercom connection through the headless kit. pi-intercom ≥ 0.18.1 is required in `README.md` and checked at start.
   - The Windows VM measure of a cold `up`.

   Nothing moves yet.
2. **B2, the GUI moves.**
   - `host.ts`'s server half moves into the server. Sessions stop hosting and adopting, and `/boss gui` and the GUI commands ask the
     server. `dashboard.ts`'s pure data is split from its pi-tui rendering, the pairing overlay stays pi-side, and nothing the server
     loads imports `tools.ts`, `pairing.ts`, or `trust/ask.ts`.
   - `gui.json` is written by the server under the unchanged contract, and `server.json` gets `gui`.
   - Remote access resumes as today.
   - The GUI's server panel with Restart server and Show log, on this computer's page only.
   - how-it-works gets **States for a shell**.
3. **B3, the link holder moves.** The holder runs in the primary server, sessions stop being candidates, and session requests go over
   the socket. The channel is kept for the previous build.
4. **B4, tower service without runs (behind `towerRuns.enabled`).** Identities with their own cwd, standing panes, tokens, head watch, digest,
   `ensure-tower`, finding tower tabs after a Herdr restart, the opener ledger and `close-main` in the server, the guard's `restarting`
   rule, conversion of resident towers.
5. **B5, local runs (behind `towerRuns.enabled`).**
   - Queue, wake, `--sb-run` and the claim, `pane-role`, the brief, `tower_done`, timeouts, crashes, and parked events.
   - Receipts after the fsync, the sender's retry of every failed send to a tower identity, and the hashed dedupe.
   - Tower tools over the socket, `tower_reply`, the `intercom` block, the prompt change.
   - `assertSettingsSafe` before every run (it needs `fix/settings-precheck` merged).
   - The GUI's tower states, queue, and composer wake.
   - `/boss tower <prompt>` (D15): it ensures the tower like a bare `/boss tower`, clears `stopped`, posts the prompt as a `boss`
     event, and answers "handed to the tower" with no focus change. A bare `/boss tower` keeps opening and focusing the tower tab.
   - A proposed pi-intercom change: a mailbox flush waits for receipts (**Queueing and concurrency**).
   - The `link` command must require the run-token kind check before any run reaches the socket (B3R-F003): today the hello secret alone
     gives full link admin (create, join, leave, answer confirms), so a run that holds the secret could administer the team. It also allows
     sending as any live tower, `taken`, the `gui` ops, and `request-open`/`request-run` without `link_request` approval; B5 and B6 scope the check to all of these.
   - `boss_server` over the run tokens (B1 has none, so its block is a session-level hook only): the server itself refuses `restart`,
     `status`, and `logs` for an ally-run token and enforces the one-a-minute restart limit server-side (today it is checked under the
     lock by the requester); `boss_server` is registered in local runs over the socket and never in ally runs.
   - From the B4 review, what B5 and B6 must do: gate `open-main`, `close-main`, and `close-tower` by the run token (refuse ally runs: today
     only the hello secret guards them, and `open-main`'s `sender` is unauthenticated); an owner check before a live-looking record is trusted
     (R13-F003), which must land before tower-tool content is sent; and read the B4 queue with its backlog in mind: B4 writes no `seen.jsonl`, the
     retry suffix (`~r<n>`) is not stripped from the message ids it wrote, and events may be a day old (at most 1000 per workspace are kept).
   - Link messages are not routed yet: with the flag on, they wait in `link/inbox/` with the GUI notice "a Straw Link message waits; ally
     runs come with the next step" until B6.
6. **B6, ally runs (behind `towerRuns.enabled`).**
   - The `link` command's run-token kind check (B3R-F003): an ally run's token never reaches link admin; see **The control socket**.
   - Routing link events into ally runs, session-level remote turns for towers, the guards of **Security**, server-side token
     enforcement, and the gate's Allow check.
   - The ally brief, its asks, and the thread store.
   - `boss_server` for ally runs: kept out of ally runs, with the remote-turn hooks kept in ally runs and in mains taking a D4 reply;
     the GUI's Restart and Show log endpoints are `local_only` (that part is B2).
   - Replies for a main (D4): `caps`, the 5-field `tower`, `tower-reply`, and `inReplyTo` in this client, `tests/link/vectors.json`,
     straw-relay's kind table, `testdata/vectors.json`, and README pointer, the relay redeployed first, the fallbacks, stale `caps`
     ignored, and the offer to the main (**In lockstep with the relay and the Straw Link spec**).
   - The amendment of the Straw Link spec's "never opens a session" rule (made in that spec with this revision) goes into how-it-works.
   - The flag goes on by default.
7. **B7, desk.** `up --dir` with the desk steps, the desk seams as **Desk mode** says, desk mode's how-it-works section.

Then Straw Link step 6 (unattended devices, as rebased above), step 7 (joining over the tailnet), and step 8 (relay deployment and
trials), unchanged otherwise.

## Tests and anchor

- **Unit.**
  - Server record and lock:
    - two starts at once start one, and a dead PID or a reused one is not live;
    - `stopped` holds against a session's look, an automatic `openTower`, a `call_tower`, and `boss_server restart`;
    - `up` and `serve` clear `stopped` in `server.json` and `gui.json`;
    - `stop` against a `serve` server exits 5.
  - Starting:
    - a fresh `restarting` is left alone, and a stale one (no touch for 10 s) counts as gone;
    - a session on an older package never starts a server;
    - a session on another scope or transport uses none;
    - the requester holds `server.lock` until `hello`, and touches `restarting.since` from its ask until `hello`;
    - a live holder keeps `server.lock` past 10 s (a start that takes 25 s is not raced), a dead one loses it at the next look, and a
      lock past 120 s is taken over;
    - `restarting.began`, `reason`, and `by` survive the starting server's touches;
    - `start-error.json` from an earlier attempt is gone when a new attempt starts, and after `hello`.
  - Slots: a pi on another Herdr socket uses a secondary server under `servers/<hash>/` that holds no link. A record whose `herdr` differs
    from its slot makes `up` fail at `herdr`. Two Herdr servers that both have workspace `w1`, with their sb servers on one broker: both
    tower identities register (`sb-tower-w1` and `sb-tower-<slot8>-w1`), each guard counts only its own, and a `call_tower` in each Herdr
    reaches its own tower.
  - The control socket: a connection without the secret, or with a wrong one, is closed with no answer.
  - The detached spawn's options are `{ detached: true, stdio: "ignore", windowsHide: true }`.
  - The constructed environment carries no `PI_INTERCOM_SESSION_ID`, `PI_INTERCOM_STABLE_ID`, `PI_SUBAGENT_*`, or `STRAW_BOSS_ROLE`, and
    keeps `PI_INTERCOM_SCOPE_ID`, `PI_INTERCOM_TRANSPORT`, and `PI_INTERCOM_TCP`, which `server.json` records.
  - The server finds `tsx` from its own package, and exits 3 with `start-error.json` `loader` without it.
  - `up`:
    - `server` is `found`, `started`, `restarted` (desk switch), or `upgraded` (older server);
    - `server_newer` without `--exact`, and exit 1 at step `version` with it;
    - `desk_on`;
    - the full JSON shape, the step list, and exit codes 0 to 3 (4 is `serve`'s and 5 is `stop`'s, tested with them);
    - a start that fails with `acl` in `start-error.json` gives exit 3 with the reason.
  - `serve`: it takes over a detached server with the same port and token; a live `serve` exits 4.
  - Every kind of restart keeps the port and token, registers the tower identities before binding the GUI ports, and a taken port moves
    only the port. The guard keeps a main while `restarting` is fresh and less than 30 s old.
  - `status` gives each state of **States for a shell**. `logs` tails the rotated log, and the log holds no message text or secret.
  - `boss_server`: status with the server down, a restart's reason in `restarting.reason` and the log, one a minute, refused while
    stopped, refused for an ally run's token and in a remote turn at every level.
  - The queue:
    - order (boss first), coalescing, and persistence across a restart;
    - dedupe by sender, base id, and content hash: a retry already taken still gets `queued`, and the same base id with other text is
      dropped and logged;
    - the receipt goes only after the fsync;
    - the sender retries any failed send to `sb-tower-*`, `E_TARGET_NOT_FOUND` included, for up to 30 s.
  - The brief builder's caps per section and in total, the ally scope, its asks and thread, and no digest or local note in an ally brief.
    The digest is cleared at `tower_done` and kept after a crash.
  - `tower_done` is refused while events are outstanding. `wakeAfter` is refused in an ally run, and a second one replaces the first.
  - Idle, the 18- and 20-minute limits, crash outcomes, flags, parked events after two crashed runs, and the crash-loop hold.
  - Run token enforcement for each tool and kind, including an ally run refused a send to a tower identity. The gate's Allow is taken
    only for its run token, call id, and arguments' digest, once.
  - Claims:
    - a pi with `--sb-run` claims once, and a second claim for the same run is refused;
    - a pi without the flag gets `quit` in an ally pane and in a standing pane within 2 minutes of a Herdr restart, and `hand` otherwise;
    - a claim before the server recorded the run's PID and start time, or before it processed a Herdr takeover, is held; a resumed pi
      with `--sb-run <old id>` is refused once the takeover is processed;
    - runs have unique names.
  - Replies for a main:
    - `awaitsReply` is written only to a device whose `caps` list it, and a 4-field `tower` and a 5-field `tower` both decode;
    - `tower-reply` is sent only with an `inReplyTo` from the run's own asks, and falls back to `tower` when the relay refuses the kind;
    - two asks in one run are answered apart;
    - a reply is taken only for an open ask from its device, once, and anything else becomes an ally run;
    - a gone main falls back to an ally run.
  - The thread store: both directions, the last 20 messages, none older than 7 days, mode 600, deleted when the device leaves the roster.
- **Packaged (B1 and B2).** It installs the way pi does, so pi's peer dependencies are not on disk:
  1. A temp `HOME` with a temp agent dir. `npm pack`, then `pi install <tarball>` with `PI_CODING_AGENT_DIR` set to the temp agent
     dir, and `pi install npm:pi-intercom@0.18.1` the same way. Where `pi install` takes no local tarball, `npm install <tarball>` runs
     in `<agent dir>/npm` with the flags pi's package manager uses (`--legacy-peer-deps --omit=peer`, read from
     `pi-coding-agent/dist/core/package-manager.js` at B1, not copied from here). A plain `npm install` would not do: npm 7 and later
     install peer dependencies, which hides exactly the failure this anchor exists for.
  2. It asserts that `<agent dir>/npm/node_modules` holds no `@earendil-works/*` and no `typebox`.
  3. Under `env -i` with only the temp `HOME`, `PATH`, and `PI_CODING_AGENT_DIR`, it starts a scratch `herdr server`, which is the
     default Herdr of that `HOME`, so nothing binds to the user's real Herdr or broker.
  4. `node <agent dir>/npm/node_modules/pi-straw-boss/dist/server/cli.mjs status` and `up` must work, and the GUI URL must answer 200.
  5. It stops the scratch server and Herdr by the PIDs it started, and removes the temp `HOME`.
  B1 implements this as `tests/server-packaged.test.ts`: `npm pack` and `npm install <tarball> pi-intercom@0.18.1 --prefix <agent dir>/npm --legacy-peer-deps` (the flags
  `package-manager.js` runs for a managed npm install), then `status`, `up`, `stop`, and the server's connection to the broker. It needs the npm registry and the `herdr`
  binary, so it runs with `SB_PACKAGED=1`; the GUI URL check (step 4) comes with B2.
- **Integration (fake Herdr and a real pi-intercom broker, as `tests/link/remote-world.ts` builds them).**
  - `call_tower` to a workspace with no run wakes one, the event arrives, and the reply leaves with `id=sb-tower-<ws>`. A main's later
    reply wakes a second run.
  - Mail sent while the server is down arrives from the broker's mailbox.
  - A server killed between reading a message and its receipt: the sender's retry delivers it once.
  - The broker behaviors in **Reality anchor** are pinned by tests, so a pi-intercom upgrade that changes them fails here: no resend, an
    unknown outcome on disconnect, `E_TARGET_NOT_FOUND`, the mailbox flush without receipts, the 256 cap, `SESSION_HELD`, and the
    mailbox-identity match by name and cwd.
  - A run named uniquely never takes the identity's mail while the identity is down, and a send by the identity's name is not ambiguous
    while a run lives.
  - The guard keeps a main across a server `upgrade`, also one whose new server takes 25 s to answer. Mains are demoted 15 s after a
    `stop`.
  - An old-build session neither adopts the GUI nor takes `holder.json`.
  - With `towerRuns.enabled` off, towers stay resident and nothing is converted.
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
  5. **Herdr restart:** `herdr server stop`, a new `herdr server`, then a `call_tower`. The server finds the tower tab again, a resumed
     run pi is quit, and the event wakes a fresh run in the restored standing pane, which claims and answers.
  6. Two agent dirs and a local relay: an ally message wakes an ally pane at `reply` while a local run works, and its gate shows in the
     GUI. A `tower_send` with `for` gets its reply into the named main. Against a relay without `tower-reply`, the reply arrives as a
     plain `tower` in an ally run.
  7. `boss_server restart` from a main, and Restart server in the GUI, both restart the server on the same URL with their reason in the
     log; the GUI's button is absent on a paired device's page and its endpoint answers 403 there.
- **Windows VM:**
  1. `cli.mjs up` brings the page up without a tower pi, and B1 records the cold `up` time against the 15 s budget (B1 has no page yet: it
     records the time to `hello`, and `url` is null). The first run (271971e) found the P0 below and 12.8 to 25.6 s; the log's phases say where
     the time goes. A `status` polled during the start never says `gone`, and `stop` takes under 2 s on POSIX.
  2. The detached server opens no console window: no window appears, and the node process has no main window handle.
  3. **A run claims:** a `call_tower` wakes a run, and its claim passes, which shows that `herdr pane process-info` reports pi's own node
     PID through the `pi.cmd` wrapper and that `startOf` reads its start time.
  4. The ACL is set and checked by SID under an account with a zh-TW name (`測試PM`): the state folder's SDDL is protected and holds
     exactly that account's SID and `SY`, with no inherited ACE; `server.json` written after it holds only those two, inherited; the
     agent dir's ACL is unchanged; and the whole check is one PowerShell start.
  5. A second local account cannot connect to the pipe (closed with no answer) and cannot read `server.json`.
  6. `up` after `stop` brings the server back; `up` with the switch against a server started without it restarts it on the same URL.
- **Review.** The change touches a shared contract (`gui.json`, `server.json`, the control socket), security (remote turns, the
  reopened main path), and the process model, so B1, B2, B3, B5, and B6 each get a fresh-context reviewer after their anchor passes.

## Risks

- **The server is now a single point.** While it is down, every workspace lacks a live tower. Mains survive a restart while `restarting`
  is fresh and through the guard's 15 s grace after that, and the broker keeps mail for 24 h, but a server that stays down demotes mains.
  The session looks and the supervisor keep that window short, and `boss_server status` and the log say why it is down.
- **Cost per wake.** Each wake starts pi (seconds on macOS, up to a minute cold on Windows). Coalescing and handling mid-run events in
  the live run keep the count down. A tower that is messaged often runs often, which is the boss's trade for not keeping it resident.
- **The broker's mailbox is fragile.** It is in memory, so a broker restart while the server is down loses the mail for tower
  identities. It holds 256 messages for every session together and evicts the oldest with nobody told. Straw Boss's sender retries for
  30 s, which covers a restart, not a long outage.
- **Mailbox flush without receipts.** Mail kept in the broker while the server was down is marked delivered when the server registers
  (`broker.ts:1344`). A crash while the server writes that batch loses it with nobody told. The window is short and bounded (**Queueing
  and concurrency**); closing it needs the pi-intercom change B5 proposes.
- **A plain `intercom send` to a tower identity during a restart** fails and is not retried by Straw Boss. The sending agent is told it
  failed.
- **pi-intercom's mailbox, receipt, and `SESSION_HELD` rules are relied on.** The integration tests pin them, and a pi-intercom upgrade is
  checked against them, as the sidecar checks `extension-bus-v1`.
- **D4 puts peer text into mains again**, bounded as **Security** says and guarded by the step-4 hooks.
- **The thread store keeps peer text at rest** (D13): at most 20 messages per device and 7 days, in the folder that holds the team keys.
- **`tsx` stays at runtime** for pi-intercom's client until pi-intercom ships JavaScript; B1's measurement says what it costs on Windows.

## Decisions (boss, 2026-10-26)

The boss took every recommendation of the first revision's open questions (D1 to D12), and decided D13 and D14 after the fresh review.
straw-boss-desk's owner also agreed to D11.

| # | Question | Decision |
|---|---|---|
| D1 | Queueing | Local events go to the live local run. Every ally message gets a fresh session, never mixed with local context. One ally run takes up to 5 waiting messages from the same device, oldest first; a message that arrives during the run waits for the next run. |
| D2 | What "送出" means as a wake trigger | Two things only: a late outcome of the tower's own send (a delivery refused or failed, an opened main that failed, a reply arriving), and the boss asking the tower from the GUI. A send on its own does not wake it. |
| D3 | Timers | No general timers. `tower_done({ wakeAfter })` only: one pending per workspace, 5 to 240 minutes. |
| D4 | An ally's reply to a question the local tower asked | `tower_send({ device, …, reply: true, for: <local session> })`. The reply goes straight to that main as peer data, with no ally run and nothing entering a tower (**Replies for a main**). A reply without `for` gets an ally run. The boss confirmed (2026-10-26), after being told it puts peer text into a full-rights main: the main's run that takes the reply is a remote turn at the replying device's level, with the step-4 hooks ("照 D4 直送，那一輪 main 套用遠端規則"). |
| D5 | An ally's `forward` confirm request | It does not wake the tower. It stays a GUI alert for the boss. |
| D6 | Concurrency | One local run per workspace, and one ally run per workspace beside it in its own pane of the tower tab. At most 4 pi runs per machine (`towerRuns.max`). |
| D7 | Lifetime of a server started from pi | Resident until stopped on purpose. A `detached` server exits only when its Herdr server has been gone for 60 s. A `serve` server lives as its supervisor says. |
| D8 | A stop on purpose leaves no live tower | Accepted. Mains are demoted after 15 s, and the stop warns of it first. Sessions do not restart a stopped server by themselves; only the boss's own commands do (**Stopping**). |
| D9 | Command names | `/boss server [stop\|restart]` inside pi, and `cli.mjs <serve\|up\|stop\|status\|restart\|logs>` at the path of **What the server runs from** for shells and supervisors (the docs call it `sb`). |
| D10 | The idle tower pane | A shell prompt. The GUI says "standing by" (待命). |
| D11 | `gui.json` | Unchanged as the GUI's contract, with `server.json` as the successor, migrated in three releases. |
| D12 | Run limits | 20 minutes per run. A steer after 60 s idle without `tower_done`, and an end 5 minutes later. The service is held after 3 failed runs in 10 minutes. |
| D13 | The ally thread for the brief keeps peer text at rest | "存，每台裝置最近 20 則、留 7 天": a per-device store of both directions, the last 20 messages, 7 days (**The brief**). |
| D14 | Restarting and debugging the server | "server restart 也要讓 agent 或 user 有辦法做，不然很難 debug": `boss_server` for local sessions and local runs, Restart server and Show log in the GUI on this computer's page only, `server.log` with rotation, `cli.mjs logs`, and the reason recorded (**Seeing and restarting the server**). |
| D15 | Prompting a tower that is not resident | "如果 tower 現在不是常駐，那會需要 /boss tower [prompt] 的指令": `/boss tower <prompt>` posts a `boss` event the way the GUI composer does, so the boss can wake the tower from any pi session; it does not change focus. A bare `/boss tower` still opens and focuses the tab. Built in B5. |

## Review record

**Review by straw-boss-desk's owner, 2026-10-26, round 1**, all applied:

1. **Windows named pipe.** A random name is no ACL. Every connection now opens with a `hello` secret kept in `server.json`, and the
   state directory gets an owner-only ACL on Windows. A Windows test checks that a second account is refused. The claim that the
   mode-600 argument carries over is gone (**The control socket**).
2. **Locating the CLI.** The stable path is `<agent dir>/npm/node_modules/pi-straw-boss/dist/server/cli.mjs`, under plain Node 22
   (**What the server runs from**).
3. **The desk switch on a live server started without it.** `up` with the switch restarts it, and `server: "restarted"` says so.
4. **`stopped`.** `up` and `serve` clear it in `server.json` and `gui.json`. Desk stops with `cli.mjs stop`, and its next `up` brings the
   server back.
5. **serve and detached.** Desk uses `up` only, and `serve` is for supervisors. `serve` takes over a live detached server, and gives
   exit 4 when a live `serve` server runs.
6. **Windows detached start.** It uses `windowsHide`, with a unit test and a VM check.
7. **Version skew.** `up` reports `version` and `package`; an older server is upgraded; a newer one gets a warning, or exit 1 with
   `--exact`.
8. **Restart and upgrade keep the port and token.** Moved is the only re-read.
9. **`up`'s JSON fields** are listed (**`up`'s output**).
10. **States for a shell** are in one table, which goes into how-it-works.

The open risk of the first revision ("whether the broker re-sends an un-acknowledged delivery") is settled from pi-intercom's source: it
does not re-send (**Reality anchor**).

**First fresh-context review, 2026-10-26** (of `bc477be`), every finding applied:

| Finding | Resolution |
|---|---|
| P1 R-F001: a run cannot recognise itself after a Herdr restore | Runs carry `--sb-run <run id>`, a flag the extension registers; a pi without it in a standing or ally pane asks `pane-role` at start. The server finds tower tabs again after a Herdr restart. Live test 5. |
| P1 R-F002: the server cannot load under plain node | The server ships prebuilt to `dist/server/`, with no value import of pi-tui, typebox, or pi-coding-agent, checked by the build; `tsx` only for pi-intercom's client. The packaged test installs the tarball into a temp agent dir. |
| P1 R-F003: `tower-reply` lost in mixed builds; ambiguous `inReplyTo` | The ask flag `awaitsReply` rides on `tower`, but as a fifth field written only to devices whose `caps` list it, since `tower` is decoded strictly (`canon.ts:46`) and a plain extra field would make older receivers drop the ask. `inReplyTo` is explicit and picked from the run's own asks. A relay refusal falls back to `tower`. |
| P2 R-F004: run and identity share a broker name | Runs are named uniquely, and the identity has a cwd of its own. A broker test. |
| P2 R-F005: sessions race a restart | Sessions leave a fresh `restarting` alone; the requester holds `server.lock` until `hello`; no start uses an older package. |
| P2 R-F006: an upgrade can outlast the guard's grace | Both: identities register before the GUI ports bind, and the guard counts an `sb-tower-*` token as live while `restarting` is fresh and under 30 s. |
| P2 R-F007: a stopped server comes back unasked | Only the boss's own commands clear `stopped`; an automatic opening fails with a notice. `stop` against `serve` refuses (exit 5) and says to stop the supervisor, because a `serve` that respected `stopped` would loop under its supervisor and hide the off state from the infra. |
| P2 R-F008: the server loses the broker scope and transport | Only identity variables are stripped; scope and transport stay and are recorded in `server.json`; sessions on another scope use no server. |
| P2 R-F009: B5 to B6 leaves link mail with no taker | B4 to B6 sit behind `towerRuns.enabled`, conversion included; between B5 and B6 link mail waits in the inbox with a GUI notice. |
| P2 R-F010: the thread cannot be built from the named sources | A per-device thread store (D13). |
| P2 R-F011: towers stop on a second Herdr | One server per state directory and Herdr socket; the primary one (default Herdr) keeps the contract paths and the link; secondary ones live under `servers/<hash>/`. |
| P2 R-F012: broker mailbox assumptions incomplete | Retry every failed send to `sb-tower-*`, not-found included, for 30 s; pi-intercom ≥ 0.18.1 required; the 256 cap, the in-memory mailbox, and the outbox's missing `outcomeKnown` are documented. |
| P2 R-F013: ally runs break a Straw Link rule | The Straw Link spec's rule is amended now, citing D1, and how-it-works follows in B6; an attended device opens nothing for a project without a tower service, and the message waits in the inbox. |
| P3: broker line numbers | Updated to the installed 0.18.1. |
| P3: chunk size | 12,000 base64 characters per chunk; 16 KiB is the broker's payload cap. |
| P3: ally pane close | The server closes the ally pane after its pi exits. |
| P3: `--exact` step | `version` is a step of `up`. |
| P3: ACL failure reporting | The child writes `start-error.json`; `up` exits 3 with its reason. |
| P3: `up` against another Herdr socket | Per-socket slots; a record naming another socket fails at `herdr`. |
| P3: claim rules | One claim per run, pane, PID, and start time; a hand-started pi only in the standing pane; a restored run is told by the pane and the Herdr restart, not by its session file. |
| P3: `wakeAfter` | Refused in ally runs; a second one replaces the first. |
| P3: ally send outcomes | Go to that device's next ally run. |
| P3: dedupe | `seen.jsonl`, 48 h, 5,000 entries, keyed by sender, base id, and content hash; a deduped retry still gets `queued`. |
| P3: "no local run holds peer text" | Narrowed to a peer's messages; ally board text and labels through `board_read` and `tower_list` are named, with their 5b limit. |
| P3: D4 list | The `origin=` limit of pi-intercom's own tool is listed for mains. |
| P3: 20-minute limit | Steer at 18 minutes, quit at 20. |
| P3: digest | Cleared at `tower_done`, kept after a crash. |
| P3: poison events | Parked after two crashed runs, with Deliver again and Drop. |
| P3: gate Allow | Tied to the run token, call id, and arguments' digest, and used once. |
| P3: localized `icacls` text | The ACL is checked by SID through the SDDL. |

**Review by straw-boss-desk's owner, round 2, 2026-10-26**, all applied:

1. The Windows ACL is verified by SID (`(Get-Acl).Sddl`), never by parsing localized text: exactly the owner's SID and SYSTEM, a
   protected DACL with no inherited ACE. A VM test runs under an account with a zh-TW name (`測試PM`).
2. The ACL is set on `straw-boss/` only, never on the agent directory.
3. The server ships prebuilt to `dist/server/*.mjs` at `prepack`. `tsx` stays at runtime for pi-intercom's TypeScript client only (it
   ships no JavaScript), so B1 measures a cold `up` on the Windows VM against a 15 s budget, and asks pi-intercom upstream for a
   JavaScript build that would make `tsx` dev-only.
4. The starting server touches `restarting.since` every 2 s, and restarting turns into gone when the touches stop for 10 s, not after a
   fixed 15 s.

**Second fresh-context review, 2026-10-26** (of `2e52f4d`; no P0 or P1), every finding applied:

| Finding | Resolution |
|---|---|
| P2 R2-F001: the lock and `restarting` can both lapse in a slow restart | `server.lock` records its holder (PID and start time) and is taken over only when that holder is dead, or past 120 s. This was chosen over a 2 s mtime refresh because a refresh depends on the holder's timers and loses the lock for a live holder that is blocked. The requester touches `restarting.since` from its ask until `hello`. |
| P2 R2-F002: identity ids collide across Herdr servers | Secondary servers put their slot in the id and name (`sb-tower-<slot8>-<ws>`, `tower · <label> · <slot8>`). Each guard counts only its own slot's ids. A test runs two Herdr servers that both have `w1`. |
| P2 R2-F003: the packaged anchor would pass with the bug | It installs as pi does: `pi install`, or npm with pi's own peer flags. It asserts that no `@earendil-works/*` and no `typebox` is on disk, and it runs under a temp `HOME` with its own scratch Herdr. |
| P3: "began less than 30 s ago" not computable; `reason` overwritten | `restarting` gains `began`, and the touches keep `began`, `reason`, and `by`. |
| P3: the dashboard split was scoped wrongly | `dashboard.ts` is split into pure data (`commanding`, `markOf`, `sessionMark`, `subagents`, `artifacts`) and pi-tui rendering. The pairing overlay stays pi-side, and `/boss gui remote` asks the server for the link. |
| P3: `tsx` "stays" a runtime dependency | Reworded: B1 adds it as the first runtime dependency. |
| P3: exit-code test; "three new kinds" | `up` is tested for 0 to 3, with 4 and 5 tested with `serve` and `stop`. The text now says two new kinds, `caps` and `tower-reply`. |
| P3: relay lockstep | The rule rows for `caps` and `tower-reply` are spelled out. straw-relay gets `testdata/vectors.json` and its README pointer, and the relay is redeployed before the client release that sends the kinds. The Straw Link spec's **Message kinds** table and its strict-decode sentence are amended in this revision. |
| P3: stale `caps` after a downgrade | A `caps` older than 2 h counts as none. |
| P3: `straw-boss/link` ends too early | It is kept, offers to resident towers included, until `towerRuns.enabled` is removed. |
| P3: claims race a Herdr takeover | A claim must match the PID and start time recorded at start, and is held until every takeover the server has seen is processed. |
| P3: Windows claim unverified | The Windows VM list adds "a run claims". |
| P3: the file ACL check rejects safe files | Files accept owner and `SY` ACEs that are explicit or inherited. The folder stays protected with no inherited ACE. The whole check is one PowerShell invocation. |
| P3: `start-error.json` never cleared | It is deleted at each start attempt and again on `hello`. |

