# How pi-straw-boss works

The full behavior behind the [README](../README.md).

## How it works

Joining is a choice, never forced.

1. A session that is not in the net gets one short reminder at the start of its first task, asking whether its current work competes with other work in the workspace for resources (ports, databases, files, branches) or needs to collaborate with it.
2. If yes, it calls `boss_join` (or the human types `/boss`). It can also join later, whenever it discovers the need. The reminder is not repeated, and a session that never joins is left alone: no prompt, no listing, no broadcasts (except scope `all`).
3. The first session of a tab to join is the tab's **main agent**; later joiners are **members**. `/boss` in a member takes the role over.
4. Subagents launched by pi-herdr-agents (recognised by `PI_SUBAGENT_ID`) never join. Their parent represents them.
5. A **sub workspace** is treated like a subagent too. `herdr worktree create` opens a linked git worktree as its own workspace (`worktree.is_linked_worktree: true`); its parent is the workspace with the same `repo_key` that is not linked. Sessions there get no reminder and no `boss_join`, `/boss` is refused, and they receive only scope `all` broadcasts. A sub workspace never gets a tower: `call_tower` from it, or aimed at it, goes to the parent workspace's tower (opened there on demand), and fails with a clear error when no parent workspace is open.

| Role | Who | Gets |
|---|---|---|
| main agent | first joiner of a tab, or the `/boss` taker-over | a short prompt: split work by app, brief workers, check results, ask the boss before merging or deploying |
| member | later joiners of a tab | a short prompt naming the main agent and the tower |
| tower | one per workspace, in its own tab labelled `tower` | a prompt for coordinating agents and repairing coordination friction; it never asks the user |

The tower is opened on demand by `call_tower` (or `/boss tower`), without taking focus, and answers through intercom. Its tab is moved to the first position of the workspace right after it is created (or adopted), through Herdr's socket API (`tab.move`, no focus change); a failed move is reported as a warning and ignored. A tower tab is recognised by the `sb_role=tower` pane token that only Straw Boss writes, never by its label, because a pi-herdr-agents subagent can be named `tower`. If two towers ever race in one workspace, the live token holder wins, otherwise the lower tab id, and the other closes its own tab. Towers of different workspaces reach each other with `call_tower`; the **head tower** is the tower of the first workspace in `herdr workspace list` order that is not a sub workspace, so there is no election.

## Tower dashboard

A tower session with a TUI shows a monitoring widget above its editor. It is read-only: it never takes focus, never prompts, and is shown only while the session holds the tower role (a tower that yields, a headless tower, and main agents never show it).

```text
╭─ ⠸ tower · Alpha ─────────────────────────────────────────── head tower ─╮
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

`/boss gui` shows the whole net in your default browser: a read-only game-style map, live and animated.

![The browser view](straw-net-gui.png)

- **Any session can open it**, in a Herdr workspace or a sub workspace, joined or not. It joins nothing, writes no token, and changes no role; a session outside the net reads the sessions through a channel of its own (`straw-boss/view/<hex of the pane id>`, never owner-eligible) that takes no part in any tab. Outside Herdr the extension is inactive, so there is no command.
- **What it shows.** Each workspace the net reaches is a **base**: one with a live tower or with sessions that joined. Workspaces with neither are not shown, and neither are sessions that did not join. A base has its **control tower** (the head tower wears a crown; a base without a tower shows a dim ghost), each tab's main agent and members as units, subagents under the session that launched them (linked exactly as the dashboard does, wherever they run), and sub workspaces as **outposts** under their parent. A net log lists joins, leaves, and state changes as they arrive.
- **States** look the same everywhere: working is a spinning ring (and a spinner badge), waiting on a question an amber `?` that hops with a pulsing ring, idle a dim `z`, finished a green `✓`, error a red `!`. Changes animate; the page honors `prefers-reduced-motion`.
- **The server** runs in the session that opened it, on `127.0.0.1` and a random free port. Every URL starts with a random token (`http://127.0.0.1:<port>/<token>/`); a request without it, with another `Host` header, or that is not a GET is refused with 403, so other local pages cannot read the net. The page is a built static bundle (`dist/gui`); the stream (`/<token>/events`) sends the full snapshot on connect and on every change, a `ping` every 15 s, and a `problem` event when Herdr or intercom cannot be read. The net is read only while a page listens.
- **Running it again** reuses the server, prints the URL, and opens the browser again. `/boss gui stop` stops it, and so does closing the session. A server started again in the same session asks for its old port and token, so a page that is still open reconnects by itself; if the port is taken it gets a new URL.
- **Background tabs.** The page treats a stream as dead after 45 s without a message and reconnects with a backoff of 1 s doubling to 30 s (±20 %), giving up after 8 failures until the tab is used again. Coming back (visible, focus, `pageshow`, `online`) reconnects at once when the stream is closed or has been quiet for 20 s, and takes a fresh full snapshot instead of replaying what was missed. While disconnected, the map is dimmed and the banner says so with the time of the last update. A hidden tab pauses its animations, draws only the newest snapshot when it returns, and holds no timer beyond the watchdog.
- **Icons** come from [game-icons.net](https://game-icons.net) by Lorc and Delapouite, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) (details in [`gui/ICONS.md`](../gui/ICONS.md)). Nothing is loaded from the network: no CDN, fonts, or runtime dependencies.

![The browser view changing state](straw-net-gui.gif)

## Tools

| Tool | Available to | What it does |
|---|---|---|
| `boss_join` | sessions not yet in the net | Join this tab's net; the first joiner is main. |
| `boss_status` | joined sessions and towers | The main agent of each tab, this workspace's tower, the head tower, and the other towers. |
| `call_tower` | joined sessions and towers | Send a message to this workspace's tower, or another workspace's by id or exact label. Opens the tower tab when none runs. |
| `boss_broadcast` | joined sessions and towers | One message to every other session in a scope. `tab`, `workspace` and `towers` reach only sessions that joined the net; `all` reaches every pi session on the machine, joined or not (for notices such as going to sleep). Default `workspace`. |

| Command | Effect |
|---|---|
| `/boss` | Join if needed, then become this tab's main agent. |
| `/boss status` | Show `boss_status`. |
| `/boss tower` | Open this workspace's tower if none runs, then focus its tab. |
| `/boss gui` | Open the whole net in the browser (any session; joins nothing). `/boss gui stop` stops the server. |

`/boss`, `boss_join`, and the reminder are unavailable in a sub workspace.

## What it writes

- Herdr pane token `sb_role` (`main`, `member` or `tower`; a tower tab is also marked right after it is created) and workspace token `tower` (the tower's intercom session id), both refreshed every 4 minutes with a 10 minute TTL and cleared at shutdown.
- A pi session entry `straw-boss` (`asked`, `joined`, `tower`) so a resumed session keeps its place without a second reminder.
- One intercom extension channel per tab, `straw-boss/tab/<hex of the tab id>`, registered only by joined sessions and towers. Tab ids over 24 characters are refused.

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

The dashboard has its own file (`src/dashboard.ts`, budget 200 lines) and its rendering is a pure function of a snapshot, so tests drive it without a terminal. The browser view's data and server (`src/net.ts`, `src/gui.ts`) share a budget of 250 lines; `buildNet` turns sessions, panes, and workspaces into the JSON snapshot as a pure function, and `collectNet` reads Herdr and intercom and reuses the dashboard's subagent linking.

The page is vanilla TypeScript in `gui/`, built by Vite (a development dependency only) into `dist/gui`, which ships in the npm package; `dist/` is not committed. The page diffs the DOM by element id, animates with CSS on `transform` and `opacity`, and its reconnect logic (`gui/stream.ts`) is tested with a fake stream and a fake clock.

`npm run gui:dev` serves the page on a local port with hot reload, fed by a demo net with invented names that changes state every few seconds. The fixture's toolbar (bottom left) has **drop stream**, **go silent** (no messages, no error: the 45 s watchdog), and **restore**, to review the disconnected page. To point the dev page at a live stream instead, run `/boss gui` and start the dev server with its URL: `GUI_LIVE=http://127.0.0.1:<port>/<token>/ npm run gui:dev`.

Prompts are plain markdown in `prompts/`, read at session start, so an edit applies after `/reload`.
