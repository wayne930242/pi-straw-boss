# pi-straw-boss

English | [繁體中文](https://github.com/wayne930242/pi-straw-boss/blob/main/README.zh-TW.md)

**Many pi agents, one project, no collisions.** pi-straw-boss gives the agents you run across [Herdr](https://herdr.dev) tabs a light chain of command: a main agent per tab, a tower per workspace, and a live view of who is doing what.

**[Try the browser view live](https://wayne930242.github.io/pi-straw-boss/)**: a demo with made-up agents that runs in your browser, nothing to install.

![The straw net in the browser: its bases with their towers, agents, subagents, and an outpost, in live states, with the alerts and the notices in the header](docs/straw-net-gui.png)

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
- **Towers talk to each other.** A tower lists every workspace's tower (`tower_list`: who a message for it reaches, what its tabs work on) and writes to one or all of them (`tower_send`); a workspace without a tower is reached through its mains, else its members. Every `call_tower`, `boss_broadcast`, and `tower_send` message opens with a header the code writes: who sent it, in what role, to whom, and whether a reply is expected ([how](docs/how-it-works.md#talking-between-towers)).
- **A work board.** A main's board fills itself from its todo list and its name (`board_set` overrides it); allies see only an auto entry's name and progress (`<name> (3/5)`), never its task text; towers read every main's entry (`board_read`), on this computer and, with Straw Link, on teammates' computers, so a tower routes work knowing where each main stands ([how](docs/how-it-works.md#the-work-board)).
- **A tower closes the mains it opened.** A main a tower opened for a request reports to the sender and to the tower, and the tower closes it (`boss_close_main`) when nothing is running in it ([how](docs/how-it-works.md#closing-an-opened-main)).
- **A digest for the tower**: joins, subagent launches, and renames in its workspace since its last run, read into its next run once and cleared ([how](docs/how-it-works.md#the-towers-digest)).
- **A browser view** of the whole net, `/boss gui`: every workspace as a base with its tower, agents, and subagents, animated and read-only. Click a base to zoom in, click a unit to read its chat as a live comms log; units that wait on you queue up as alerts, and Space opens the next one, F enlarges the top dialog, and Escape closes it (none of them while you type); a question is answered from the keyboard too: arrows choose, Tab moves between questions, and Enter confirms and goes on. A switch in the header's settings (the gear) raises a system notification, and another plays a sound, when a unit waits on you, fails, or finishes; finished units wait in a list of their own, cleared one by one or all at once, and a finished subagent on the map is dismissed one by one or all at once (Dismiss finished, beside the location). A unit's comms show its background monitors, and one that fails or goes quiet raises a notice (a quiet entry under the header's Notices button; only a unit waiting on you raises the prominent alert); a unit that is idle while a subagent of it works, or while a monitor of it runs, shows as commanding with a glow, and one that only waits on a running monitor shows its note in red. On a desktop a unit's terminal takes your keyboard once you click into it. It reads in English or Traditional Chinese, following your browser, with a language menu in the header's settings. + New base, the last card on the map, opens a base in a folder you pick with one member and no tower. A base without a tower takes more members (+ Member on the base adds one in a new tab, on a squad beside that squad), and its tower opens by the rules above; a base with a tower takes new mains (+ Main, on the base or in the tower's comms), each in a tab of its own. In a session's composer, a file pasted, dropped, or picked with + (20 MB at most) is stored in a private temp folder and its path goes into the message. × closes a base, a squad, or (in its view) a unit after a confirmation: each agent quits pi as `/quit` would, then its pane, tab, or workspace closes; nothing closes if one of them refuses. Each opening form takes an optional first message; the folder is picked in Finder-style columns (with New folder, and the base named after the folder by default), staying inside your home folder and skipping hidden folders (on Windows also the ones with the Hidden or System attribute, such as AppData and the old profile links), and while the unit opens a deploy panel shows the real steps (create, start, join the net, deliver the first message) with each step's clock, and names the step and the reason when one fails. A pi that must confirm project trust before it starts (a folder with `.pi/` settings, extensions, skills, or MCP servers) asks in the GUI as an alert too, with the folder, what trusting would load, and Trust, Trust this time, or Don't trust (the terminal can answer as well, and the first answer counts; a paired phone may answer; the deploy panel of an opening shows it inline).
- **Broadcast** to a tab, a workspace, every tower (a workspace without one, through its mains or members), or every session.
- **Tidy tabs.** When a pi starts in a tab or quits out of it, the tab's panes are made equal again, so workers split off one by one don't leave a chain of halves.
- **Stranded subagents are asked to report.** A subagent that stays open after finishing, while the pi that launched it was restarted and no longer receives its result, is asked once over intercom to send its final report there ([how it works](docs/how-it-works.md#orphaned-subagents)).
- **Subagents a Herdr restart brought back as plain pi sessions are resumed.** A restart (`resume_agents_on_restore`) starts a plain `pi --session` in each subagent's pane, without what makes it a child, so its result never arrives. Straw Boss closes that restored pane and asks the launching session to resume the run with pi-herdr-agents' `subagent_resume`; a managed-worktree run keeps its pane and is reported instead ([how it works](docs/how-it-works.md#subagents-a-herdr-restore-brought-back-plain)).
- **A net view in Herdr's sidebar.** An optional plugin turns the Agents list into the net, towers first and each subagent under its launcher, on by default and switched by one key.
- **A reaper for leftover worktree panes.** A second optional plugin closes the panes agents leave behind in worktree workspaces, removes the clean checkouts nothing holds, and keeps the workspaces you pin.

## Install

```bash
pi install npm:pi-straw-boss
```

### Requirements

- pi running inside [Herdr](https://herdr.dev) 0.9.4 or newer.
- Herdr's pi integration (`herdr integration install pi`): without it Herdr does not name a pane's pi session, and the session cannot join the net; each session warns once, 20 s after its start, when it is missing.
- [pi-intercom](https://www.npmjs.com/package/pi-intercom) 0.18.1 or newer: the net's channels, messages, and the GUI's dialog relay run over it, and so does the sb server's connection (it checks the version at start and says so in `start-error.json` and `boss_server status` when pi-intercom is older or missing).
- Windows support is experimental: the extension reaches Herdr over its named pipe there, the sidebar plugin runs with the `node` on `PATH`, and the worktree reaper is macOS and Linux only ([what differs](docs/how-it-works.md#windows)).

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
| [straw-boss](https://github.com/wayne930242/straw-boss) (Claude Code and Codex) | A Claude Code or Codex main-agent session joins the tab's net through a small sidecar process that straw-boss starts with the session: a member, or a main when it registers as an orchestrator. It shows in the tower dashboard, the sidebar, and the GUI with an agent badge (the GUI cannot type into it), calls the tower and broadcasts with `straw-net.py`, and hears net messages as `[straw net …]` lines typed into its pane ([how](docs/how-it-works.md#from-claude-code-or-codex)). |

Any extension's `select` and `confirm` (an `mp-infra` command review, say) can be answered from the GUI too, with no change to that extension: Straw Boss wraps them on pi's shared `ctx.ui`, opens pi's own dialog as always, and relays the same dialog; the first answer wins. Both can be answered from a paired device. `input`, `editor`, and `custom` are never touched, and they, with `ask_user` from pi-ask-user, show read-only in the GUI, with the terminal one tap away.

## Quick start

1. Open pi in a Herdr tab and give it work. It joins the net by itself; when its work grows it promotes itself to the tab's main agent, which also opens the workspace tower. You can take over with `/boss`.
2. Type `/boss status` to see each tab's main agent and the towers.
3. Type `/boss tower` to open the workspace's tower and watch its dashboard. It also opens by itself when agents start to collide.
4. Type `/boss gui` from any session to see the whole net in your browser.

The tower only routes and coordinates, so it can run a lighter model: set `towerModel` in `~/.pi/agent/straw-boss/config.json` ([how it works](docs/how-it-works.md#how-it-works)). The tower service of the sb server is on by default: the tower is a run that wakes for the events it gets and ends with a handoff note (`/boss tower <prompt>` writes to it), and a teammate's Straw Link message gets an ally run of its own. Each run starts fresh; what has to outlive it (your standing instructions and decisions, and the tower's open waits) sits in a small memory you read and change with `/boss memory`, or in the tower's comms in the GUI; the tower can only propose a standing instruction or a decision, and it takes effect when you confirm it ([how it works](docs/how-it-works.md#tower-memory)). Set `{ "towerRuns": { "enabled": false } }` there to keep resident towers ([how it works](docs/how-it-works.md#the-tower-service-b4)).

## Tools and commands

| Name | What it does |
|---|---|
| `boss_promote` | Become this tab's main agent (refused while it has one). |
| `boss_status` | Main agents, this workspace's tower, and the other towers. |
| `call_tower` | Message this workspace's tower, or another workspace's (under a header). `why` says milestone, shared, or blocked: the three points a main calls it; `reply: false` for a notice. |
| `boss_open_main` | Tower only: open a tab with a new main agent for a request no session owns. |
| `boss_close_main` | Tower only: close a main this tower opened, once nothing runs in it. |
| `tower_list` | Tower only: every workspace's tower, who a message for it reaches, its state, and what its tabs work on. |
| `tower_send` | Tower only: message one other tower (by workspace id or label), or all of them. |
| `board_read` | Tower only: the work board: what each main is doing and how far it is, here and on teammates' computers. |
| `board_set` | A tab's main: override its own board entry (one line of current work, up to 8 checklist items), or `auto: true` to give it back to the auto-fill from its todo list and name. |
| `boss_broadcast` | Message a tab, a workspace, all towers, or every session (under a header). |
| `boss_server` | See the sb server (status works with the server down), read its log (up to 200 lines), or restart it with a reason. Refused while the boss stopped the server, once a minute at most, and never in a remote turn. |
| `boss_rename` | Name this session with a short phrase for its current work; the net and the GUI show it, and a main agent's tab takes it as its label. Main agents call it when their work changes. |
| `/boss` | Take over as this tab's main agent. |
| `/boss status`, `/boss tower` | Show the status; open and focus the tower. |
| `/boss memory [-w workspace]`, `/boss memory confirm P1`, `reject P1`, `add standing\|decision <text>`, `edit S1 <text>`, `delete D1`, `resolve W1` | Read and change the tower's memory from pi: its standing instructions, decisions, and waits, and the proposals the tower made that wait for you. The GUI's Memory panel is the same operation. See [Tower memory](docs/how-it-works.md#tower-memory). |
| `/boss server`, `/boss server stop`, `/boss server restart [reason]` | Show the sb server and start it when it is down; stop it on purpose (after a confirm; nothing but a boss command starts it again); restart it (after a confirm) on the same port; the GUI keeps its address, so open pages reconnect by themselves. See [The sb server](docs/how-it-works.md#the-sb-server). |
| `/boss close` | Quit this session and close its pane. |
| `/boss close all` | Quit this base's tower, mains, and members and close it with its shells, without stashing. It is checked first as a stash checks it; anything running that would be lost (a turn, a queued message, a dialog, a monitor, a subagent, a busy shell) closes nothing, and every reason is listed. Other bases are never touched. |
| Stash, Stashed, Pop on the page | A base's Stash puts it away under its label; the HUD's Stashed list opens each one again with Pop. A base's Quit is checked first, as `/boss close all` is. |
| `/boss stash [name]`, `/boss pop [name]` | Put this whole base away (its tower, mains, members, and idle shells) and close it; open it again later, every pi resumed from its own session file in its old role. A stash refuses, naming why, while anything a resume would lose is there: a running turn, a queued message, an open dialog, a running monitor, a subagent, or a busy shell. |
| `/boss gui`, `/boss gui stop`, `/boss gui rotate` | Open the net in the browser (any session, joins nothing); stop its GUI, from any session. The GUI is served by the sb server, one per machine, so it does not depend on which pi session runs: `/boss gui` starts the server when none runs and prints the URL, and a server that went down comes back when any pi session starts or looks (or from `cli.mjs up`). The URL carries a random token that is kept across a restart, an upgrade, a crash, a reboot, and a `/boss gui stop` followed by `/boss gui` (on the same port, in `gui-secrets.json`), so a page left open reconnects by itself and a phone stays paired. A new token comes only from `/boss gui rotate` (after a confirm; it unpairs every phone and opens the new address), a missing or corrupt `gui-secrets.json`, or a port that was taken at the next start: the old address then answers 403 and a phone scans the QR code again. Keeping the token has a cost you chose: another account on this machine that binds the port during a crash or restart gap sees what an open page sends; rotate after a gap you do not trust. With `STRAW_BOSS_DESK=1` (a desk shell shows the page itself) it opens no browser and the page leaves out Phone and Stash. Only `/boss gui stop` keeps the GUI stopped, until the next `/boss gui` or `cli.mjs up`; `/boss stash` and `/boss close all` do not start a stopped GUI. The header's Server button (this computer's page only) shows the server's state, restarts it, and shows its log. Type into a session from its comms view, or work its terminal with the key pad under the terminal tile, or on a desktop by clicking into it and typing; answer a waiting `robot_hand` selector, `ask_user_question` questionnaire, or pi-code hook confirmation there or in its alert (so can any extension's `select` and `confirm`, also from a paired device; other dialogs show read-only, to answer in the terminal; `secret_drop` always takes its secret in the terminal, never on a page, local or over the tailnet, because pi-intercom identities are self-reported). Documents a session shows with [pi-herdr-doc-review](https://www.npmjs.com/package/pi-herdr-doc-review) 0.4.0 or newer open beside its comms: HTML in a sandboxed frame whose form answers the agent, text read-only. |
| `/boss gui lan`, `/boss gui lan off`, `/boss gui lan reset` | Reach the GUI from a phone on the same Wi-Fi, without Tailscale. It is off until you turn it on. This computer makes its own certificate, after showing you the risk: anyone who copies its key from this computer could pose to your phones as private-network sites (your router's page, a NAS) until you remove it from each phone. So use it on your phone's hotspot, or on a Wi-Fi that connects the phone directly to this computer. Each phone installs the certificate once (AirDrop or Quick Share it from the computer, and check it as the screen says), then pairs by QR code or typed code, and you allow each new phone on the computer by typing the number it shows. [How it works](docs/how-it-works.md#browser-view). |
| `/boss gui remote`, `/boss gui remote off` | Reach the GUI from your phone over your tailnet (`tailscale serve`, never Funnel): pair by QR code (or, in an installed app, by the short code shown beside it), and a phone stays paired (90 days from its last use, `remote off` included) until you unpair it in the Phone tile or the GUI gets a new token (a pairing belongs to the token, which a restart keeps; `/boss gui rotate`, a lost `gui-secrets.json`, or a taken port makes a new one and the old pairings are cleared); remote access stays on across a restart or a new server until `remote off`, and a paired phone keeps working after a restart; after a new token a phone pairs again: in the browser by scanning the QR code, in an installed app by typing the pairing code (see below); off removes only its own serve entry. The serve entry points at a second loopback listener of the sb server's GUI, so a request is remote because of the listener it arrived on, whatever headers it carries. The page installs as an app (Add to Home Screen, or Chrome's Install) with a fixed entry, `https://<this machine>.<tailnet>.ts.net:8443/sb-app/`, as its start URL (a token-free address on the tailnet listener only): open with a pairing, it leads to the current page; open without one (after a new token, or on iOS, where the app keeps cookies of its own and scanning the QR in Safari never reaches it), it shows a field for the **pairing code** that `/boss gui remote` prints under the QR (and the Phone tile shows beside it). The code is 8 characters, works once within ten minutes, and is void after five wrong tries until you ask this computer for a new one. An app installed before this entry existed opens its old address, which now leads to the entry as well. |
| `node dist/server/cli.mjs up --dir <folder> --label <name>` (a shell, not a pi command) | The desk steps of `up`, for a shell that shows the page itself (straw-boss-desk): with `STRAW_BOSS_DESK=1` set in the environment of `herdr server` and of this command, it installs Herdr's pi integration when it is not current, makes the shell's home base (a workspace in the folder, recorded in `desk.json` and found again by its workspace id), has the sb server stand in for its tower, waits for the GUI, and prints one JSON line with `url`, `workspace`, `pane`, `tower`, `created`, and `integration`. Idempotent: a second run opens nothing. Without the switch it exits 2. See [Desk mode](docs/how-it-works.md#desk-mode-up---dir). |

Subagents and sessions in Herdr worktree workspaces never join: the session that launched them speaks for them. Outside Herdr the extension does nothing.

## Net view in the sidebar

An optional Herdr plugin in [`herdr-plugin/`](herdr-plugin) turns the sidebar's Agents list into a net view.
It lists the head tower's workspace first, in each workspace the tower, then each tab's main agent and members, and every subagent right under the session that launched it, even in a worktree workspace.
The view is on whenever the Herdr server starts, and one key switches it off and on again.
pi-straw-boss writes the sort key (`sb_order`), a role label (`sb_mark`) and, on subagents, a tree branch (`sb_indent`) and the subagent's name (`sb_name`) the view and your sidebar rows can use.
It needs Herdr 0.9.5 or newer and node.

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

On Windows the action is `wayne930242.straw-boss.net-windows` (Herdr wants an action id unique across platforms).
Run `herdr server reload-config` to load the key, and `herdr plugin unlink wayne930242.straw-boss` to remove the plugin.
`herdr plugin install wayne930242/pi-straw-boss/herdr-plugin` installs it from GitHub instead of a checkout.
[How it works](docs/how-it-works.md#sidebar-net-view) has the tokens and a sidebar rows snippet that shows each member's role in Herdr's own view too.

## Leftover worktree panes

A second optional Herdr plugin, in [`herdr-reaper/`](herdr-reaper), cleans up after agents that ran in worktree workspaces.
In a workspace whose worktree is a linked git worktree (whatever its name), it closes the pane of an agent that has exited once the pane's shell is idle, and never the focused pane.
Herdr then closes the tab and the workspace, and the plugin removes the workspace's checkout if `git status` is clean and nothing else is using it (no other pane works in it, no other workspace is open on it).
A worktree that pi-herdr-agents created is kept until its parent session removes it with `worktree_remove`, for as long as the parent session is open in a Herdr pane (or, if it is not, until it has been silent for 72 hours, `retain_idle_hours`), and so is any checkout a process of yours has as its working directory.
Git-ignored files (`.env`, `node_modules`, caches, local databases) do not make a checkout dirty, so they are deleted with it.
The branch always stays, and so does a dirty checkout, with the reason in the plugin log.
A checkout with initialized submodules is removed only when every submodule (nested ones too) has no uncommitted or untracked paths and its HEAD is contained in a remote-tracking ref (or in a ref of the main repository's own copy of the module), so no commit is lost; the reaper then runs `git submodule deinit --all`, deletes the worktree's `.git/worktrees/<id>/modules` (which git refuses to remove the worktree around), and runs a plain `git worktree remove`. Otherwise it stays and the log names the submodule and why; if a removal fails partway and leaves files git no longer tracks, the log says "half-removed" and names the directory for you to delete.
When Herdr opened a plain shell workspace for the main checkout to group the worktrees under, the plugin remembers it, and closes it once no worktree workspace of that repository is left and it holds only idle shells (no agent, not pinned, not renamed, not focused); the checkout and branches are untouched.
Every other workspace, including a main-checkout workspace that never had a worktree under it, is left alone.
It sweeps every 10 minutes and a minute after an agent exits, and the `reap-now` action sweeps at once.
Every close, removal, skip and pin is a line in the plugin log (`herdr plugin log list --plugin wayne930242.straw-boss-reaper`).

A pinned workspace is never reaped and its checkout is never removed; that is all a pin does. Closing a pinned workspace closes it.
Renaming a workspace pins it at once, and the `pin` action toggles the pin of the workspace it runs in; unpinning leaves the name as it is.
The pin is the workspace token `$pin`, a Nerd Font pin glyph, which a Space row shows once you add it.
It needs Herdr 0.9.3 or newer, git and node 18 or newer.
It runs on macOS and Linux only: on Windows, Herdr does not report what a pane's shell is running, so the reaper could not tell an idle pane from one running a build or an editor.

```bash
herdr plugin install wayne930242/pi-straw-boss/herdr-reaper
```

```toml
[[keys.command]]
key = "prefix+i"
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

[How it works](docs/how-it-works.md) covers roles, the tower, the dashboard, the browser view, what the extension writes, and how Claude Code or Codex sessions join the net.

## License

MIT. The browser view's icons come from [game-icons.net](https://game-icons.net) (Lorc and Delapouite, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)); see [gui/ICONS.md](gui/ICONS.md).
