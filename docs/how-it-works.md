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
npm run check   # tsc --noEmit
npm test        # node --test, against a fake Herdr and a fake intercom broker
```

The dashboard has its own file (`src/dashboard.ts`, budget 200 lines) and its rendering is a pure function of a snapshot, so tests drive it without a terminal.

Prompts are plain markdown in `prompts/`, read at session start, so an edit applies after `/reload`.
