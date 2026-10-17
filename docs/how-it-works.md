# How pi-straw-boss works

The full behavior behind the [README](../README.md).

## How it works

Joining is automatic; the chain of command is earned.

1. Every joinable pi in Herdr joins its tab's net at session start as a **member**: no reminder, no question. It does not join outside Herdr, as a pi-herdr-agents subagent (`PI_SUBAGENT_ID`, its parent represents it), in a sub workspace (below), or as the tower itself.
2. A member becomes its tab's **main agent** by promotion. The agent calls `boss_promote` when its work grows (several steps, dispatching workers, more than one app); the member prompt says so. A member that calls pi-herdr-agents' `subagent` or `subagent_resume` tool without promoting is promoted automatically, before the subagent starts or resumes. A join that failed at start and retries after the session's pane moved to another tab registers on the tab it is in now, so it never becomes a second main there.
3. A tab has one main. An agent never takes over an existing one: while the tab's main is live, `boss_promote` is refused with a message and the automatic promotion is skipped. The member may still dispatch its own subagents, but its prompt tells it to first message the main through intercom with what it will do and which resources it will use.
4. A main never demotes. When its session ends, the tab has no main until a member promotes (the members' prompt then offers promotion). `/boss` is the user's manual takeover: it makes this session the tab's main even when another is.
5. The workspace's first main opens the workspace tower at once; later mains, in any tab, find it open. The tower stays open when mains leave.
6. A promoted session keeps the subagents it launched: the dashboard and the browser view link subagents through the launcher's session file, not through its role, so they count under it as main with no re-registration.
7. A **sub workspace** is treated like a subagent too. `herdr worktree create` opens a linked git worktree as its own workspace (`worktree.is_linked_worktree: true`); its parent is the workspace with the same `repo_key` that is not linked. Sessions there never join, `/boss` is refused, and they receive only scope `all` broadcasts. A sub workspace never gets a tower: `call_tower` from it, or aimed at it, goes to the parent workspace's tower (opened there on demand), and fails with a clear error when no parent workspace is open.

| Role | Who | Gets |
|---|---|---|
| main agent | the member that promotes first in a tab, or the `/boss` taker-over | a short prompt: split work by app, brief workers, check results, ask the boss before merging or deploying |
| member | every other joined session | a short prompt: with a main in the tab, tell it before dispatching subagents; without one, promote when the work grows |
| tower | one per workspace, in its own tab labelled `tower` | a prompt for coordinating agents and repairing coordination friction; it never asks the user |

The tower is opened by the workspace's first main (or earlier on demand, by `call_tower` or `/boss tower`), without taking focus, and answers through intercom. Its tab is moved to the first position of the workspace right after it is created (or adopted), through Herdr's socket API (`tab.move`, no focus change); a failed move is reported as a warning and ignored. A tower tab is recognised by the `sb_role=tower` pane token that only Straw Boss writes, never by its label, because a pi-herdr-agents subagent can be named `tower`. If two towers ever race in one workspace, the live token holder wins, otherwise the lower tab id, and the other closes its own tab. Towers of different workspaces reach each other with `call_tower`; the **head tower** is the tower of the first workspace in `herdr workspace list` order that is not a sub workspace, so there is no election.

## Tower dashboard

A tower session with a TUI shows a monitoring widget above its editor. It is read-only: it never takes focus, never prompts, and is shown only while the session holds the tower role (a tower that yields, a headless tower, and main agents never show it). Its first lines say what the pane is, the channel main agents reach each other through with `call_tower`, and give the straw net GUI's link while a GUI server answers (otherwise that `/boss gui` opens it).

```text
╭─ ⠸ tower · Alpha ─────────────────────────────────────────── head tower ─╮
│ Control tower: main agents talk here (call_tower).                       │
│ GUI  http://127.0.0.1:52662/<token>/                                     │
│                                                                          │
│ this net                                                                 │
│ ├─ tab api-main                                                          │
│ │  ├─ ○ api-main        main                                             │
│ │  │  └─ ⠏ psb-sleeper  subagent  bash                                   │
│ │  └─ ○ docs-member     member                                           │
│ └─ tab other                                                             │
│    └─ ? ops-main        main      waiting on a question                  │
│ other towers                                                             │
│ ✓ Beta                  tower                                            │
╰──────────────────────────────────────────────────────────────────────────╯
```

- **This net**, in detail: the sessions that joined in this workspace, by tab (main agent first, then members), each with the subagents it launched, and this workspace's sub workspaces. Sessions that did not join are not listed, and neither is anything in other workspaces.
- **Other towers**: one line per workspace that has a live tower (workspace, status, and `head tower` for the head one).
- One glyph and theme color per state: a spinner in the accent color for working, `?` warning for waiting on a question, `○` dim for idle, `✓` success for done, `✗` error. Colors come from the active pi theme. The title mark shows the most urgent state of the net.
- The spinner runs at 8 fps only while something is working. The data is polled every 3 s while the widget exists, and an intercom presence, join, or leave event re-reads at once (at most every 0.5 s). Shutdown, or losing the tower role, removes the widget and every timer.

Where the data comes from: pi-intercom `listSessions()` (status `idle`, `thinking`, `tool:<name>`, and the Herdr location of each session), `herdr pane list` (`sb_role` token, Herdr's agent status where `blocked` means waiting on a question, and the pi session file), and `herdr workspace list` (workspace status, `tower` token, linked-worktree fields). Subagents are linked to their parent through pi-herdr-agents' own layout: the parent's session file names its artifacts directory, `subagent-activity/<child id>.json` there records each child's activity, and the child's pane session file contains the child id. So a subagent is grouped under the session that launched it wherever it runs, and it never counts as a net member of the workspace or tab it sits in.

## Browser view

`/boss gui` shows the whole net in your default browser: a game-style map, live and animated, where you can read any unit's comms and type into its session.

![The browser view](straw-net-gui.png)

- **Any session can open it**, in a Herdr workspace or a sub workspace, joined or not. It changes no role and writes no token; a joined session reads the sessions through its tab channel, and one that cannot join (a sub workspace) through a channel of its own (`straw-boss/view/<hex of the pane id>`, never owner-eligible) that takes no part in any tab. Outside Herdr the extension is inactive, so there is no command.
- **What it shows.** Each workspace the net reaches is a **base**: one with a live tower or with sessions that joined. Workspaces with neither are not shown, and neither are sessions that did not join. A base has its **control tower** (the head tower wears a crown; a base without a tower shows a dim ghost), each tab's main agent and members as units, subagents under the session that launched them (linked exactly as the dashboard does, wherever they run), and sub workspaces as **outposts** under their parent. A net log lists joins, leaves, and state changes as they arrive.
- **States** look the same everywhere: working is a spinning ring (and a spinner badge), waiting on a question an amber `?` that hops with a pulsing ring, idle a dim `z`, finished a green `✓`, error a red `!`. Changes animate; the page honors `prefers-reduced-motion`.
- **Routes.** The map is `/<token>/`.
  A base opens as `/<token>/w/<workspace id>` and a unit as `/<token>/w/<workspace id>/s/<session key>`, optionally with `?at=<entry id>` to open its comms at one entry.
  Links are real links (middle-click and copy-link work); a plain click, Back, and Forward change the view without reloading, and Escape goes up one level.
  The **Straw Net** title in the header goes back to the map.
  A deep link loads straight into its view.
- **A base, zoomed in.** The workspace route draws the base large on the map's grid: its control tower, each tab as a squad of unit tokens with the same icons and state badges, subagents tethered under the unit that launched them, outposts, and the workspace's other pi panes as unaligned units (outside the net, grey, with a dashed ring).
  Each unit shows its last assistant line, read from the end of its session file.
  Entering a base zooms out of its spot on the map.
- **A unit's comms.** The session route shows the session's chat as a comms log: your messages in gold on the right, the unit's transmissions on the left with its icon, each tool call as a collapsed action card with a state badge (running, done, failed), thinking folded behind its length, compactions as dividers.
  The side column shows the unit's dossier (portrait, role, state, model, context use, directory, base, squad, launcher, dispatched subagents).
  New entries appear when pi writes them; text still being streamed is not in the file yet, so it shows at the end of the reply.
  The log opens at the newest entry and stays pinned there as new ones arrive.
  Scrolled up, it stays where you are and a floating button offers the way back (**jump to latest**, or **N new** once entries arrived); the button scrolls to the end and pins the log again.
  Older pages load as you scroll up; at most 600 entries stay in the page.
  Under the log, the **composer** types into the unit's terminal through Herdr, as if typed there: **Send** (Enter; Shift+Enter adds a line) sends a prompt when it is idle and a steering message while it works, **Follow-up** (Alt+Enter, shown while it works) queues one, **Stop** sends Escape after a confirm, and **Focus terminal** brings its pane forward.
  A leading `/` or `!` runs a pi or shell command; commands that end or replace the session (`/quit`, `/exit`, `/new`, `/resume`, `/fork`, `/clone`, `/import`, `/reload`) ask first.
  Text lands after anything still unsent in the terminal's editor and is submitted with it.
  The box clears only once Herdr confirmed the input, keeping anything typed meanwhile; a send that was not confirmed is never repeated (check the terminal). What the page could not say when the answer came (you were on another session, or the page reloaded) is kept and shown when you come back: why a send was refused, that it was not confirmed, or, if you edited text that had already been sent, that the original already went. It never says "your edits stayed" about an empty box (the browser refused storage).
  It is disabled, with the reason, while the stream is down, the session is gone, or it waits on a dialog (answer that in the panel above it when it can be answered there, else in the terminal).
  Subagents are typed into directly, like any session. Ctrl+C and Ctrl+D are never sent from the browser.
  On a touch screen Enter adds a line and Send sends; drafts survive a reload.
  Markdown is rendered by the page's own renderer into DOM nodes, never as HTML, and only `http`, `https`, and `mailto` links are links; block quotes and lists nest at most 16 deep, and deeper levels stay text.
- **Alerts and panels.** A unit that starts waiting on a question or fails, and a subagent that finishes, raise an alert.
  An alert never opens anything by itself: it joins the queue in the header (questions and errors first, then the rest, oldest first), and leaves it again when the unit moves on.
  You open alerts from the queue or by clicking a unit that waits; they open as dialogs in the dock over the side column.
  A second dialog you open stacks on top, with the one beneath peeking out; click the part that peeks out to bring it up (a click that really lands on a control under the strip, such as the Phone button, goes to that control). A dialog you are reading is never covered by one you did not open: alerts only queue, and the overlay model puts any open without your action beneath the top dialog, without focus (no such open exists yet; it is the rule for later arrivals). Closing the top reveals the one beneath, and with none beneath, the next queued question or error.
  **Later** puts the alert back in the queue and opens nothing else; if the unit moved on while its dialog was open, the alert is stale and leaves instead. A dialog is never closed under you: if its unit leaves the net while it is open, the dialog shows **gone** ("left the net"), without its question, Focus terminal, or Open comms.
  The queue is counted the same way in the header (its tooltip) and in every dialog ("Also queued: 1 needs you · 1 finished"): questions and errors need you and are what closing a dialog reveals next; a unit that only finished waits in the queue for you to open it and is counted apart. A dialog's Focus terminal goes quiet the moment the stream drops, not at the next snapshot.
  **Open comms** goes to the unit's comms at the entry the alert was about (read when the alert arrived: the reply with the tool call it waits on, else its last reply), loading older pages when needed, and lights that entry for a moment; the comms log stays there with **jump to latest** until you go down. It closes the alert without opening the next queued one, so nothing covers the comms you went to.
  The entry is in the URL (`?at=`), so Back, Forward, and the link itself land on it again; an entry no longer in the history opens at the newest one, as does opening a unit any other way.
  Escape closes the top dialog only, focus returns to where it was, and dialogs are not modal (the page stays usable, nothing traps focus).
  Documents open as **tiles** beside the current view instead, sharing its width; a tile that arrives by itself takes no focus, and narrow windows show tiles as tabs.
  A dialog shows the unit, its last line, and the tool call it waits on, with a link to its comms.
- **Questions and selectors.** When a unit waits on a dialog, its alert dialog and its session view (above the composer) show it. Two kinds can be answered from the page (0.6.0): pi-robot-hand's selector (`robot_hand` ≥ 0.3.0: its title as written, each choice with where it acts and the terminal's number, **Copy command**, which copies through the browser and answers nothing) and @juicesharp/rpiv-ask-user-question's questionnaires (`ask_user_question`: one to four questions, each with its header tag, options with descriptions as radio buttons or, when it takes several, checkboxes, "Or type your own answer", and "Note (optional)"). **Send answer** goes to the package that opened the dialog, which settles it exactly as a terminal answer would, so the terminal's dialog closes and the agent gets the answer once; the panel then says "Answered.", or "It was already answered in the terminal." when the terminal was first, the owner's reason when it refused (still answerable), and "Not confirmed. Check the terminal" with **Check again** (which resends the same answer, never a new one) when no confirmation came. From a phone over the tailnet, a choice that acts on this computer (robot_hand's clipboard) is hidden and refused. No key is sent and the screen is never read: each session's dialog bridge (`src/bridge.ts`, in every pi in Herdr, subagents too) relays the dialogs its packages publish on pi's event bus to the GUI server's session over an intercom extension channel only that session may own, and the server lets the page answer a dialog only when it is the session's one open dialog, belongs to the session file's open call, and matches what the page showed (dialog id and digest; see [Answering pi dialogs](specs/2026-10-18-dialog-answers.md)). Everything else stays read-only with **Focus terminal** and the reason: `ask_user` (pi-ask-user), several open dialogs, an answer already on its way, a dialog too long to relay, or one that differs from the session file. `secret_drop` shows only that it waits for a secret and is never answerable. A unit with an open dialog counts as waiting at once; otherwise it is waiting while Herdr reports its pane `blocked`, which pi reports from the `herdr:blocked` event; Straw Boss's extension entry `src/blocked.ts` relays rpiv's `rpiv:ask-user:blocked` into it, once per open questionnaire. The question shown is the newest unanswered call on the session's current branch; a call longer than 256 KB is read from further back in the file (up to 16 MB, shown clipped), and a longer one says it is too long to read.
- **The server** runs in the session that opened it, on `127.0.0.1` and a random free port. Every URL starts with a random token (`http://127.0.0.1:<port>/<token>/`); a request without it or with another `Host` header is refused with 403, so other local pages cannot read the net. The only writes are POSTs under `/<token>/api/sessions/<key>/` (`input`, `keys`, which accepts only Escape, `focus`, and `answer`, which carries a dialog's answer to its owner and sends no key) and `/<token>/api/remote/pair`; each needs the page's own `Origin`, `Sec-Fetch-Site: same-origin` when sent, a JSON body of at most 64 KB, and the CSRF secret written into the page, and the server asks Herdr right then that the pane still runs pi on that session's file. Typed text is never logged. The page is a built static bundle (`dist/gui`); any route answers the same page, which carries a `<base href>` so it loads from any depth. The stream (`/<token>/events`) sends the full snapshot on connect and on every change, a `ping` every 15 s, and a `problem` event when Herdr or intercom cannot be read; `events?watch=<session key>` adds that session's history, and `events?watch=w:<workspace id>` the last line of each unit there. `/<token>/api/history/<key>` and `/<token>/api/entry/<key>/<entry id>` page through a session and fetch one entry in full (capped at 1 MB). The net is read only while a page listens.
- **Session files.** The server reads only the session files of units in the net it just read (joined sessions, towers, subagents through their pane or launch script, and the other pi panes of a base); a path never comes from the browser. A file is read only from a pane running pi, only as a `.jsonl` under pi's sessions directory (`sessions/` in `PI_CODING_AGENT_DIR` or `~/.pi/agent`, symlinks resolved on both sides), and for an intercom session only when it is named for that session, so a net read during `/new` cannot pair the old session with the next file; a watched session whose file changes re-attaches to the new one. A file is indexed in 1 MB chunks from the first and last bytes of each line, about 25 ms for a 54 MB session, and only the index stays in memory; entries are read by offset for the page being sent. Indexing, appends, and reads run one at a time in order, so entries pi writes during the first index wait for it, and a read never uses the index of a file that was replaced. A rewritten file or a branch move resets the page. A first page that cannot be read is tried again on the next net reading. A unit that leaves the net stays readable for ten minutes, with a link to the pane's new session when there is one.
  Sessions stored elsewhere (`--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, or pi's `sessionDir` setting) show on the map but have no history and cannot be typed into.
- **Remote access.** `/boss gui remote`, in the session that runs the server, puts the GUI on your tailnet: it adds one `tailscale serve` entry, HTTPS on port 8443 proxying to the local server (never Funnel), and shows a QR code in a pi overlay. Scan it with a phone signed in to Tailscale as this machine's user. In the overlay, **c** copies a link and **o** opens one in this computer's browser; every QR, copy, and open is its own one-time link that works once, within ten minutes, and **Esc** or **q** closes it. While the overlay is open the session counts as waiting, so input from the browser is refused rather than lost in it. The HUD's **Phone** button shows a fresh QR in the page too. A paired device gets a session cookie (HttpOnly, Secure, SameSite=Strict, seven days); every remote request must also carry this machine's Tailscale user in `Tailscale-User-Login`, which `tailscale serve` sets, and the exact MagicDNS host. Port 8443 is taken only when it is free or already this server's, and `/boss gui remote off`, `/boss gui stop`, or the end of the session remove only that entry (other serve entries are never touched) and end every remote session. It says why and changes nothing when Tailscale is missing, signed out, a tagged node, without MagicDNS, or 8443 serves something else. The layout works on a phone: no sideways scrolling, larger touch targets, safe-area insets, and the composer stays above the on-screen keyboard. The net log folds away from its heading, and on a phone shows only its two newest entries.
- **One server per machine.** Running `/boss gui` again, in this session or any other, opens the server that already runs instead of starting a second one; two calls at the same moment share one start. `gui.json` in `~/.pi/agent/straw-boss/` (or under `PI_CODING_AGENT_DIR`) records the running server (pid, port, token, CSRF secret, owner session, mode 600), `gui.lock` makes the check-and-start atomic, and `remote.json` records the serve entry's target, the owner's PID, and when that process started while remote access is on, so the next server removes an entry a crashed one left: a recorded server counts as running only when its PID is alive and that process is the one that started at the recorded time, so a PID another process now holds is not mistaken for the owner, while a server that really runs keeps its entry. `/boss gui stop` stops it only in the session that runs it; elsewhere it names that session. Closing that session stops the server too. The next `/boss gui`, from any session, asks for the old port and token, so a page that is still open reconnects by itself; if the port is taken it gets a new URL.
- **Background tabs.** The page treats a stream as dead after 45 s without a message and reconnects with a backoff of 1 s doubling to 30 s (±20 %), giving up after 8 failures until the tab is used again. Coming back (visible, focus, `pageshow`, `online`) reconnects at once when the stream is closed or has been quiet for 20 s, and takes a fresh full snapshot instead of replaying what was missed. While disconnected, the map is dimmed and the banner says so with the time of the last update. A hidden tab pauses its animations, draws only the newest snapshot when it returns, and holds no timer beyond the watchdog.
- **The QR encoder** is the package's own (`src/qr.ts`), adapted in part from Project Nayuki's QR Code generator library (MIT, see [`NOTICE.md`](../NOTICE.md)); there are still no runtime dependencies.
- **Icons** come from [game-icons.net](https://game-icons.net) by Lorc and Delapouite, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) (details in [`gui/ICONS.md`](../gui/ICONS.md)). Nothing is loaded from the network: no CDN, fonts, or runtime dependencies.

![The browser view changing state](straw-net-gui.gif)

## Pane balance

A second extension entry, `src/balance.ts`, keeps Herdr tabs even. When a pi starts in a tab (once per process, so `/reload` does not count) and after a pi quits and Herdr closes its pane, the panes of that tab get equal widths along each split, and stacked panes equal heights. It runs in every pi inside Herdr, joined or not, and leaves a zoomed tab alone. A pane that outlives its pi (a shell you keep) changes nothing.

The work runs in `src/balance.mjs` as a detached `node` process: `balance.mjs now <pane>` at start, `balance.mjs after-close <pane> <tab>` at quit, because the quitting pi exits before Herdr closes its pane. Each resize is planned from a freshly read layout, and a per-tab lock under the system temp directory (`pi-straw-boss-pane-balance/`) makes concurrent sessions take turns instead of applying the same change twice.

## Tools

| Tool | Available to | What it does |
|---|---|---|
| `boss_promote` | joined sessions that are not the tower | Become this tab's main agent; refused while the tab has a live main. |
| `boss_status` | joined sessions and towers | The main agent of each tab, this workspace's tower, the head tower, and the other towers. |
| `call_tower` | joined sessions and towers | Send a message to this workspace's tower, or another workspace's by id or exact label. Opens the tower tab when none runs. |
| `boss_broadcast` | joined sessions and towers | One message to every other session in a scope. `tab`, `workspace` and `towers` reach only sessions that joined the net (nearly every pi in Herdr, not sub workspace sessions); `all` reaches every pi session on the machine, joined or not (for notices such as going to sleep). Default `workspace`. |

| Command | Effect |
|---|---|
| `/boss` | Take over as this tab's main agent, even when it has one. |
| `/boss status` | Show `boss_status`. |
| `/boss tower` | Open this workspace's tower if none runs, then focus its tab. |
| `/boss gui` | Open the whole net in the browser (any session; joins nothing). `/boss gui stop` stops the server. |

`/boss` and `boss_promote` are unavailable in a sub workspace.

## What it writes

- Herdr pane token `sb_role` (`main`, `member` or `tower`; a tower tab is also marked right after it is created) and workspace token `tower` (the tower's intercom session id), both refreshed every 4 minutes with a 10 minute TTL and cleared at shutdown.
- A pi session entry `straw-boss` (`tower`) so a resumed tower keeps its role. Members write no entry: every session joins at start, so entries saved by 0.4.0 (`asked`, `joined`) are ignored.
- While remote access is on, one `tailscale serve` entry (HTTPS 8443, proxying to the GUI server), removed when it goes off.
- One intercom extension channel per tab, `straw-boss/tab/<hex of the tab id>`, registered by every joined session and tower; the channel's owner (the first to join) only records the main, and it is not the main by that. Tab ids over 24 characters are refused.
- The dialog channel `straw-boss/gui/<sha256 prefix of the server's session id>`: registered owner-eligible only by the session running the GUI server, and joined by a session (subagents included) only while it has a dialog open and `gui.json` (which records the server's session as `ownerSession`) names another session.

The tower tab is labelled `tower` and its Herdr agent is named `tower-<workspace id>` in lowercase (Herdr agent names are unique per server).

## From Claude Code or Codex

Read-only discovery works from any shell in a Herdr pane:

```bash
herdr workspace get "$HERDR_WORKSPACE_ID" | jq -r '.result.workspace.tokens.tower'
herdr pane list --workspace "$HERDR_WORKSPACE_ID" | jq -r '.result.panes[] | select(.tokens.sb_role) | [.pane_id, .tokens.sb_role] | @tsv'
node ~/.pi/agent/npm/node_modules/pi-intercom/cli.mjs ask --to "$TOWER_SESSION_ID" --text "<message>"
```

Opening a missing tower needs a pi session.

## Development

```bash
npm install
npm run check      # tsc --noEmit for the extension and for the page
npm run gui:build  # builds the page into dist/gui (npm test and npm pack do this first)
npm test           # node --test, against a fake Herdr and a fake intercom broker
npm run gui:dev    # the page with hot reload against a demo net; see below
```

The dashboard has its own file (`src/dashboard.ts`, budget 200 lines) and its rendering is a pure function of a snapshot, so tests drive it without a terminal. The browser view's data and server (`src/net.ts`, `src/gui.ts`) share a budget of 300 lines; `buildNet` turns sessions, panes, and workspaces into the JSON snapshot as a pure function (and fills the registry of readable session files), and `collectNet` reads Herdr and intercom and reuses the dashboard's subagent linking. The session reader (`src/history.ts`), the entry-to-item mapping (`src/items.ts`), and the stream and API glue (`src/watch.ts`) are tested against fixture files.

The page is vanilla TypeScript in `gui/`, built by Vite (a development dependency only) into `dist/gui`, which ships in the npm package; `dist/` is not committed. The page diffs the DOM by element id, animates with CSS on `transform` and `opacity`, and its reconnect logic (`gui/stream.ts`) is tested with a fake stream and a fake clock.
The map's chunk holds the map, the header, the router, and the alert spotting (`gui/alerts.ts`).
The focus views (`gui/views.ts`), the comms log with the markdown renderer (`gui/chat.ts`, `gui/markdown.ts`), and the overlay layer's DOM and tiles (`gui/layer.ts`) load on first use.
The overlay rules (`gui/overlay.ts` for the dialog stack, `createTiles` in `gui/layer.ts`) are pure and tested without a browser (`tests/overlay.test.ts`); phase 2 and 3 dialogs (ask_user, robot_hand, secret_drop) and show_doc documents plug into the same stack and tiles.
Size budgets are checked by `tests/imports.test.ts`: the map's chunk ≤ 15 KB (6 KB gzipped), the lazy chunks together ≤ 35 KB (12 KB), the stylesheet ≤ 22.1 KB (6.1 KB).

`npm run gui:dev` serves the page on a local port with hot reload, fed by a demo net with invented names that changes state every few seconds. The demo includes a session with every kind of chat entry (open any unit), and the fixture's toolbar (bottom left) has **drop stream**, **go silent** (no messages, no error: the 45 s watchdog), **restore**, to review the disconnected page, and **doc arrives**, which opens a demo document as a tile the way a show_doc document will. To point the dev page at a live stream instead, run `/boss gui` and start the dev server with its URL: `GUI_LIVE=http://127.0.0.1:<port>/<token>/ npm run gui:dev`.

To check a checkout in real pi while your own `/boss gui` server runs (one server per machine, so `/boss gui` would open that one), start a scratch pi with `--no-extensions`, `-e` for pi-intercom and your provider, and `-e` for a two-line wrapper that calls this checkout's `createStrawBoss({ stateDir: "<scratch dir>", openUrl: async () => {} })`.
Its `/boss gui` then runs a second server from the checkout, recorded in the scratch directory, and opens no browser.

Prompts are plain markdown in `prompts/`, read at session start, so an edit applies after `/reload`.
