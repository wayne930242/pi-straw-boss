# pi-straw-boss

Straw Boss coordination for [pi](https://pi.dev) sessions that run in [Herdr](https://herdr.dev): a session **joins** a small net when its work competes or collaborates with other work in the workspace, the first to join a tab becomes its **main agent**, one **tower** per workspace opens on demand, and `boss_broadcast` reaches the rest. No tracking, no scheduler, no new service: the extension is glue over pi-intercom and Herdr metadata.

## Requirements

- pi, running inside a Herdr pane
- [pi-intercom](https://www.npmjs.com/package/pi-intercom) 0.17.1 or newer
- Herdr 0.9.4 or newer

Outside Herdr the extension does nothing.

## Install

```bash
pi install npm:pi-straw-boss
```

While developing: `pi install ~/projects/pi-straw-boss` loads the working tree, and `/reload` picks up edits.

## How it works

Joining is a choice, never forced.

1. A session that is not in the net gets one short reminder at the start of its first task, asking whether its current work competes with other work in the workspace for resources (ports, databases, files, branches) or needs to collaborate with it.
2. If yes, it calls `boss_join` (or the human types `/boss`). It can also join later, whenever it discovers the need. The reminder is not repeated, and a session that never joins is left alone: no prompt, no listing, no broadcasts (except scope `all`).
3. The first session of a tab to join is the tab's **main agent**; later joiners are **members**. `/boss` in a member takes the role over.
4. Subagents launched by pi-herdr-agents (recognised by `PI_SUBAGENT_ID`) never join. Their parent represents them.

| Role | Who | Gets |
|---|---|---|
| main agent | first joiner of a tab, or the `/boss` taker-over | a short prompt: split work by app, brief workers, check results, ask the boss before merging or deploying |
| member | later joiners of a tab | a short prompt naming the main agent and the tower |
| tower | one per workspace, in its own tab labelled `tower` | a prompt for coordinating agents and repairing coordination friction; it never asks the user |

The tower is opened on demand by `call_tower` (or `/boss tower`), without taking focus, and answers through intercom. If two towers ever race in one workspace, the live token holder wins, otherwise the lower tab id, and the other closes its own tab. Towers of different workspaces reach each other with `call_tower`; the **head tower** is the tower of the first workspace in `herdr workspace list` order, so there is no election.

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

## What it writes

- Herdr pane token `sb_role` (`main`, `member` or `tower`) and workspace token `tower` (the tower's intercom session id), both refreshed every 4 minutes with a 10 minute TTL and cleared at shutdown.
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

Prompts are plain markdown in `prompts/`, read at session start, so an edit applies after `/reload`.

## License

MIT
