# pi-straw-boss

**Many pi agents, one project, no collisions.** pi-straw-boss gives the agents you run across [Herdr](https://herdr.dev) tabs a light chain of command: a main agent per tab, a tower per workspace, and a live view of who is doing what.

![The straw net in the browser: three workspaces with their towers, agents, a subagent, and an outpost, with live states](docs/straw-net-gui.png)

<p align="center"><sub><code>/boss gui</code>: every workspace of the net, live, in your browser. <a href="docs/straw-net-gui.gif">Watch it move</a>.</sub></p>

![The tower's dashboard in the terminal: this net's tabs, agents, and subagents, and the other towers](docs/tower-dashboard.png)

## Why

Run a few agents on the same project and they start stepping on each other: two dev servers on one port, two branches editing the same migration, and no agent knows the others exist. pi-straw-boss lets them find each other and coordinate, without a scheduler or a new service.

- **Everyone joins.** Each pi in Herdr joins its tab's net at start as a member; nothing to ask or remember.
- **A main agent per tab, by promotion.** An agent whose work grows calls `boss_promote`, or is promoted when it first dispatches a subagent. A tab has one main, and nobody takes it over except you with `/boss`.
- **A tower per workspace.** It opens with the workspace's first main in its own tab, pinned first, and coordinates the main agents and the other towers, and opens a tab with a main agent for work no session owns. You don't need to talk to it.
- **A live dashboard** in the tower: who joined, and what they and their subagents are doing.
- **A browser view** of the whole net, `/boss gui`: every workspace as a base with its tower, agents, and subagents, animated and read-only. Click a base to zoom in, click a unit to read its chat as a live comms log; units that wait on you queue up as alerts.
- **Broadcast** to a tab, a workspace, every tower, or every session.
- **Tidy tabs.** When a pi starts in a tab or quits out of it, the tab's panes are made equal again, so workers split off one by one don't leave a chain of halves.
- **Stranded subagents are asked to report.** A subagent that stays open after finishing, while the pi that launched it was restarted and no longer receives its result, is asked once over intercom to send its final report there ([how it works](docs/how-it-works.md#orphaned-subagents)).
- **A net view in Herdr's sidebar.** An optional plugin turns the Agents list into the net, towers first and each subagent under its launcher, on by default and switched by one key.

## Install

```bash
pi install npm:pi-straw-boss
```

You need pi running inside Herdr 0.9.4 or newer, and [pi-intercom](https://www.npmjs.com/package/pi-intercom) 0.17.1 or newer. [pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents) is optional: with it, subagents show up under the session that launched them.

## Quick start

1. Open pi in a Herdr tab and give it work. It joins the net by itself; when its work grows it promotes itself to the tab's main agent, which also opens the workspace tower. You can take over with `/boss`.
2. Type `/boss status` to see each tab's main agent and the towers.
3. Type `/boss tower` to open the workspace's tower and watch its dashboard. Agents open it themselves when they call it.
4. Type `/boss gui` from any session to see the whole net in your browser.

The tower only routes and coordinates, so it can run a lighter model: set `towerModel` in `~/.pi/agent/straw-boss/config.json` ([how it works](docs/how-it-works.md#how-it-works)).

## Tools and commands

| Name | What it does |
|---|---|
| `boss_promote` | Become this tab's main agent (refused while it has one). |
| `boss_status` | Main agents, this workspace's tower, and the other towers. |
| `call_tower` | Message this workspace's tower, or another workspace's. |
| `boss_open_main` | Tower only: open a tab with a new main agent for a request no session owns. |
| `boss_broadcast` | Message a tab, a workspace, all towers, or every session. |
| `/boss` | Take over as this tab's main agent. |
| `/boss status`, `/boss tower` | Show the status; open and focus the tower. |
| `/boss gui`, `/boss gui stop` | Open the net in the browser (any session, joins nothing); stop its server. Type into a session from its comms view, or work its terminal with the key pad under the terminal tile; answer a waiting `robot_hand` selector or `ask_user_question` questionnaire there or in its alert (other dialogs show read-only, to answer in the terminal; `secret_drop` stays terminal-only). Documents a session shows with [pi-herdr-doc-review](https://www.npmjs.com/package/pi-herdr-doc-review) 0.4.0 or newer open beside its comms: HTML in a sandboxed frame whose form answers the agent, text read-only. |
| `/boss gui remote`, `/boss gui remote off` | Reach the GUI from your phone over your tailnet (`tailscale serve`, never Funnel): pair by QR code; off removes only its own serve entry. |

Subagents and sessions in Herdr worktree workspaces never join: the session that launched them speaks for them. Outside Herdr the extension does nothing.

## Net view in the sidebar

An optional Herdr plugin in [`herdr-plugin/`](herdr-plugin) turns the sidebar's Agents list into a net view.
It lists the head tower's workspace first, in each workspace the tower, then each tab's main agent and members, and every subagent right under the session that launched it, even in a worktree workspace.
The view is on whenever the Herdr server starts, and one key switches it off and on again.
pi-straw-boss writes the sort key (`sb_order`), a role label (`sb_mark`) and, on subagents, a tree branch (`sb_indent`) and the subagent's name (`sb_name`) the view and your sidebar rows can use.
It needs Herdr 0.9.3 or newer and node.

<p align="center"><img src="docs/sidebar-net-view.png" width="308" alt="Herdr's sidebar in the net view: each workspace's tower with the radio tower glyph first, each main agent on two rows with a star and its tab's label, and every subagent on a tree branch under the session that launched it"></p>

<p align="center"><sub>The net view with each agent's role mark. <a href="docs/how-it-works.md#sidebar-net-view">How it works</a> has the sidebar rows that show them.</sub></p>

Link it from a checkout, then bind a key in Herdr's `config.toml`:

```bash
herdr plugin link /path/to/pi-straw-boss/herdr-plugin
```

```toml
[[keys.command]]
key = "prefix+alt+n"
type = "plugin_action"
command = "wayne930242.straw-boss.net"
description = "toggle the straw net view"
```

Run `herdr server reload-config` to load the key, and `herdr plugin unlink wayne930242.straw-boss` to remove the plugin.
`herdr plugin install wayne930242/pi-straw-boss/herdr-plugin` installs it from GitHub instead of a checkout.
[How it works](docs/how-it-works.md#sidebar-net-view) has the tokens and a sidebar rows snippet that shows each member's role in Herdr's own view too.

## Learn more

[How it works](docs/how-it-works.md) covers roles, the tower, the dashboard, the browser view, what the extension writes, and how Claude Code or Codex agents can find a tower.

## License

MIT. The browser view's icons come from [game-icons.net](https://game-icons.net) (Lorc and Delapouite, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)); see [gui/ICONS.md](gui/ICONS.md).
