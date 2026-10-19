# pi-straw-boss

English | [繁體中文](https://github.com/wayne930242/pi-straw-boss/blob/main/README.zh-TW.md)

**Many pi agents, one project, no collisions.** pi-straw-boss gives the agents you run across [Herdr](https://herdr.dev) tabs a light chain of command: a main agent per tab, a tower per workspace, and a live view of who is doing what.

**[Try the browser view live](https://wayne930242.github.io/pi-straw-boss/)**: a demo with made-up agents that runs in your browser, nothing to install.

![The straw net in the browser: its bases with their towers, agents, subagents, and an outpost, in live states, with the alerts and the finished units in the header](docs/straw-net-gui.png)

<p align="center"><sub><code>/boss gui</code>: every workspace of the net, live, in your browser. <a href="docs/straw-net-gui.gif">Watch it move</a>.</sub></p>

<p align="center"><img src="docs/gui-comms.png" width="49%" alt="A unit's comms: its chat as a live log, the messages queued for its next turn, its todo list, its background monitors, and its dossier with documents and dispatched subagents"> <img src="docs/gui-alert.png" width="49%" alt="An alert dialog with the question a unit waits on, answerable from the browser, beside the list of finished units under the header's Done button"></p>

<p align="center"><img src="docs/gui-phone-map.png" width="220" alt="The map on a phone"> <img src="docs/gui-phone-comms.png" width="220" alt="A unit's comms on a phone"></p>

<p align="center"><sub>A unit's comms, a question you can answer from the browser, and the same page on a phone.</sub></p>

![Herdr with pi-straw-boss: the sidebar's net view of every workspace, tower, main agent, and subagent, beside a main agent at work](docs/herdr-window.png)

<p align="center"><sub>Herdr with the net view in its sidebar.</sub></p>

![The tower's dashboard in the terminal: this net's tabs, agents, and subagents, and the other towers](docs/tower-dashboard.png)

## Why

Run a few agents on the same project and they start stepping on each other: two dev servers on one port, two branches editing the same migration, and no agent knows the others exist. pi-straw-boss lets them find each other and coordinate, without a scheduler or a new service.

- **Everyone joins.** Each pi in Herdr joins its tab's net at start as a member; nothing to ask or remember.
- **A main agent per tab, by promotion.** An agent whose work grows calls `boss_promote`, or is promoted when it first dispatches a subagent. A tab has one main, and nobody takes it over except you with `/boss`.
- **A tower per workspace.** It opens in its own tab, pinned first, when agents start to collide: a member dispatches a subagent (it promotes itself first), a workspace has two members while another workspace already has a tower, an agent promotes itself, or you type `/boss tower`. Mains and the tower go together: a tower that opens promotes each tab's earliest member, and a tower that quits turns every main back into a member (its subagents stay). It and coordinates the main agents and the other towers, and opens a tab with a main agent for work no session owns. You don't need to talk to it.
- **A live dashboard** in the tower: who joined, and what they and their subagents are doing.
- **A browser view** of the whole net, `/boss gui`: every workspace as a base with its tower, agents, and subagents, animated and read-only. Click a base to zoom in, click a unit to read its chat as a live comms log; units that wait on you queue up as alerts. A header switch raises a system notification, and another plays a sound, when a unit waits on you, fails, or finishes; finished units wait in a list of their own, cleared one by one or all at once. A unit's comms show its background monitors, and one that fails or goes quiet raises an alert. On a desktop a unit's terminal takes your keyboard once you click into it. It reads in English or Traditional Chinese, following your browser, with a language menu in the header. + New base, the last card on the map, opens a base in a folder you pick with one member and no tower. A base without a tower takes more members (+ Member on the base adds one in a new tab, on a squad beside that squad), and its tower opens by the rules above; a base with a tower takes new mains (+ Main), each in a tab of its own. In a session's composer, a file pasted, dropped, or picked with + (20 MB at most) is stored in a private temp folder and its path goes into the message. × closes a base, a squad, or (in its view) a unit after a confirmation: each agent quits pi as `/quit` would, then its pane, tab, or workspace closes; nothing closes if one of them refuses. Each opening form takes an optional first message, and the folder picker stays inside your home folder and skips hidden folders.
- **Broadcast** to a tab, a workspace, every tower, or every session.
- **Tidy tabs.** When a pi starts in a tab or quits out of it, the tab's panes are made equal again, so workers split off one by one don't leave a chain of halves.
- **Stranded subagents are asked to report.** A subagent that stays open after finishing, while the pi that launched it was restarted and no longer receives its result, is asked once over intercom to send its final report there ([how it works](docs/how-it-works.md#orphaned-subagents)).
- **A net view in Herdr's sidebar.** An optional plugin turns the Agents list into the net, towers first and each subagent under its launcher, on by default and switched by one key.
- **A reaper for leftover worktree panes.** A second optional plugin closes the panes agents leave behind in worktree workspaces, removes the clean checkouts, and keeps the workspaces you pin.

## Install

```bash
pi install npm:pi-straw-boss
```

### Requirements

- pi running inside [Herdr](https://herdr.dev) 0.9.4 or newer.
- [pi-intercom](https://www.npmjs.com/package/pi-intercom) 0.17.1 or newer: the net's channels, messages, and the GUI's dialog relay run over it.

### Works with

Each of these is optional. When it is installed, Straw Boss picks it up; without it, the rest works as before.

| Package | What Straw Boss does with it |
| --- | --- |
| [pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents) | Subagents show under the session that launched them, in the tower dashboard, the sidebar, and the GUI; a member that dispatches one is promoted to main and its tower opens. |
| [@juicesharp/rpiv-ask-user-question](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) 2.13 or newer | `ask_user_question` questionnaires can be answered from the GUI, and a waiting one marks its unit as waiting. |
| [pi-robot-hand](https://www.npmjs.com/package/pi-robot-hand) 0.3.0 or newer | `robot_hand` selectors can be answered from the GUI. |
| pi-code (hooks extension, with its dialog events) | Its hook confirmation ("Allow bash?": Allow or Deny, before any gated tool call) can be answered from the GUI. |
| [pi-herdr-doc-review](https://www.npmjs.com/package/pi-herdr-doc-review) 0.4.0 or newer | Documents a session shows open beside its comms: HTML in a sandboxed frame whose form answers the agent, text read-only. |
| [@juicesharp/rpiv-todo](https://www.npmjs.com/package/@juicesharp/rpiv-todo) 2.13 or newer | A session's todo list shows above its composer in the GUI, read from the session file. |

Other dialogs (`select`, `confirm`, `input`, and `editor` from any extension, `ask_user` from pi-ask-user) show read-only in the GUI, with the terminal one tap away.

## Quick start

1. Open pi in a Herdr tab and give it work. It joins the net by itself; when its work grows it promotes itself to the tab's main agent, which also opens the workspace tower. You can take over with `/boss`.
2. Type `/boss status` to see each tab's main agent and the towers.
3. Type `/boss tower` to open the workspace's tower and watch its dashboard. It also opens by itself when agents start to collide.
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
| `boss_rename` | Name this session with a short phrase for its current work; the net, the GUI, and (with pi-auto-tab-name) the tab show it. Main agents call it when their work changes. |
| `/boss` | Take over as this tab's main agent. |
| `/boss status`, `/boss tower` | Show the status; open and focus the tower. |
| `/boss close` | Quit this session and close its pane. |
| `/boss gui`, `/boss gui stop` | Open the net in the browser (any session, joins nothing); stop its server, from any session. The machine runs one server on one URL: it comes back after its session's `/reload`, and a session on a newer pi-straw-boss takes it over, so open pages reload into the new version. Type into a session from its comms view, or work its terminal with the key pad under the terminal tile, or on a desktop by clicking into it and typing; answer a waiting `robot_hand` selector, `ask_user_question` questionnaire, or pi-code hook confirmation there or in its alert (other dialogs show read-only, to answer in the terminal; `secret_drop` stays terminal-only). Documents a session shows with [pi-herdr-doc-review](https://www.npmjs.com/package/pi-herdr-doc-review) 0.4.0 or newer open beside its comms: HTML in a sandboxed frame whose form answers the agent, text read-only. |
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

## Leftover worktree panes

A second optional Herdr plugin, in [`herdr-reaper/`](herdr-reaper), cleans up after agents that ran in worktree workspaces.
In a workspace whose worktree is a linked git worktree (whatever its name), it closes the pane of an agent that has exited once the pane's shell is idle, and never the focused pane.
Herdr then closes the tab and the workspace, and the plugin removes the workspace's checkout if `git status` is clean and nothing else is using it (no other pane works in it, no other workspace is open on it).
Git-ignored files (`.env`, `node_modules`, caches, local databases) do not make a checkout dirty, so they are deleted with it.
The branch always stays, and so does a dirty checkout, with the reason in the plugin log.
A checkout with initialized submodules is removed only when every submodule (nested ones too) has no uncommitted or untracked paths and its HEAD is contained in a remote-tracking ref (or in a ref of the main repository's own copy of the module), so no commit is lost; the reaper then runs `git submodule deinit --all`, deletes the worktree's `.git/worktrees/<id>/modules` (which git refuses to remove the worktree around), and runs a plain `git worktree remove`. Otherwise it stays and the log names the submodule and why; if a removal fails partway and leaves files git no longer tracks, the log says "half-removed" and names the directory for you to delete.
When Herdr opened a plain shell workspace for the main checkout to group the worktrees under, the plugin remembers it, and closes it once no worktree workspace of that repository is left and it holds only idle shells (no agent, not pinned, not renamed, not focused); the checkout and branches are untouched.
Every other workspace, including a main-checkout workspace that never had a worktree under it, is left alone.
It sweeps every 10 minutes and a minute after an agent exits, and the `reap-now` action sweeps at once.
Every close, removal, skip and pin is a line in the plugin log (`herdr plugin log list --plugin wayne930242.straw-boss-reaper`).

A pinned workspace is never reaped.
The `pin` action toggles the pin of the workspace it runs in, and a workspace you rename more than a minute after it appeared is pinned for you (pi-herdr-agents names its workspaces within seconds, which pins nothing); unpinning also renames it back.
The pin is the workspace token `$pin`, a Nerd Font pin glyph, which a Space row shows once you add it.
It needs Herdr 0.9.3 or newer, git and node 18 or newer.

```bash
herdr plugin install wayne930242/pi-straw-boss/herdr-reaper
```

```toml
[[keys.command]]
key = "prefix+P"
type = "plugin_action"
command = "wayne930242.straw-boss-reaper.pin"
description = "pin or unpin the workspace"

[ui.sidebar.spaces]
rows = [["state_icon", "workspace", { token = "$pin" }], ["branch", "git_status"]]
```

`herdr plugin link /path/to/pi-straw-boss/herdr-reaper` links a checkout instead, and `herdr plugin unlink wayne930242.straw-boss-reaper` removes the plugin.
The plugin starts reaping as soon as it is installed or linked, with no trial run and no confirmation: its first sweep treats every idle, agent-less pane in a linked-worktree workspace as one whose agent exited, about a minute and a half after the first hook runs.
Run `bash herdr-reaper/run.sh reaper.mjs dry-run` first to see what it would do, and pin the workspaces you want to keep (the pin action works once the plugin is linked, and a `config.json` with `only_under` can be put in the plugin's config directory before that).
[How it works](docs/how-it-works.md#worktree-reaper) has the rules and the limits.

## Learn more

[How it works](docs/how-it-works.md) covers roles, the tower, the dashboard, the browser view, what the extension writes, and how Claude Code or Codex agents can find a tower.

## License

MIT. The browser view's icons come from [game-icons.net](https://game-icons.net) (Lorc and Delapouite, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)); see [gui/ICONS.md](gui/ICONS.md).
