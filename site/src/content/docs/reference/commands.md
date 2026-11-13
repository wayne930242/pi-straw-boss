---
title: Commands
description: Every tool pi-straw-boss gives agents, and every /boss command.
---

Agents call the **tools**; you type the **`/boss` commands** in any pi session inside Herdr.
`/boss` commands are the boss's typed input only: a tower run, an ally run, or a paired device's composer cannot type them, except where a row says otherwise.
`/boss` and `boss_promote` are unavailable in a sub workspace.

"Who has it" names the kind of session, as [Concepts](/pi-straw-boss/docs/guide/concepts/) defines them:

- **Joined sessions**: every pi that joined its tab's net (members and mains).
- **Towers**: the tower's runs, and the head tower's where a row says so.
- **Local tower runs**: the tower's [runs](/pi-straw-boss/docs/guide/concepts/#how-a-tower-runs) on this computer, not a teammate's *ally run*.

## Tools

| Tool | Who has it | What it does |
| --- | --- | --- |
| `boss_promote` | joined sessions | Become this tab's main agent; refused while the tab has a live main. |
| `boss_status` | joined sessions and towers | The main agent of each tab and its kind, this workspace's tower, the head tower, and the other towers. |
| `boss_duty` | a tab's main | Set its kind with a reason: `coordinator`, `integrator`, or `standing`. The kind is the prompt it runs and shows on the page. |
| `boss_rename` | joined sessions | Name the session with a short phrase for its current work; a main's tab takes it as its label. A role label (a tower's glyph, `train <MMDDx>`) is refused. |
| `call_tower` | joined sessions and towers | Message this workspace's tower, or another workspace's, under a header. `why` is `milestone`, `shared`, or `blocked`; `reply: false` for a notice. |
| `boss_broadcast` | joined sessions and towers | Message a tab, a workspace, every tower, or every session, under a header naming every recipient. |
| `board_set` | a tab's main | Override its own work board entry (one line and up to 8 checklist items); `auto: true` hands it back to the auto-fill, `clear: true` deletes it. |
| `boss_server` | joined sessions | The sb server's `status` (also with it down), its `logs` (up to 200 lines), or `restart` with a reason. Refused while the boss stopped the server, at most once a minute, and never in a remote turn. |
| `link_request` | every session on an attended computer, and a local tower run | Ask for a Straw Link action (create, invite, join, trust, leave, remove, role, rotate) with a reason. It never runs unasked: the boss approves it in a dialog. |
| `boss_open_main` | towers | Open a tab with a new main agent for a request no session owns. `role: "train"` opens a train; `role: "integrator"` sends a car slip to the project's one integrator, opening it when none runs. `duty: "standing"` opens a main of kind standing (default coordinator). See [Merge train](/pi-straw-boss/docs/guide/merge-train/). |
| `boss_close_main` | towers | Close a main this tower opened, once nothing runs in it. |
| `tower_list` | towers | Every workspace's tower, who a message for it reaches, its state, and what its tabs work on (each tab's main with its kind). |
| `tower_send` | towers | Message one other tower (by workspace id or label) or all of them; with `device`, the tower of a teammate's computer. |
| `board_read` | towers | The work board: what each main is doing and how far it is, here and on teammates' computers. |
| `tower_memory` | local tower runs | Keep what outlives the run: a standing instruction or a decision quoted from the boss's own message, and the tower's waits, including a wait on the boss as a card. |
| `tower_reply` | tower runs, not the head tower's | Answer one local session (a main or a member) by its intercom name or session id, under the tower's header. `forward` carries a car slip's event id to an integrator. |
| `tower_done` | tower runs | End this run with a handoff note (one item per line, up to 1,200 characters) for the next run; `wakeAfter` (5 to 240 minutes, local runs only) asks for a follow-up run. Refused while events are still waiting for the run. |
| `boss_auto` | the head tower | Start or end [auto mode](/pi-straw-boss/docs/guide/auto-mode/) on the boss's own words in the turn it answers. |
| `train_car` | the integrator and trains | Set a car's state (`received`, `returned`, `dropped`, `landed`); the sb server tells the car's coordinator. Its `car` is the car's first ticket; the slip's `car:` (or `app:`) names the app. |

The full table, with every argument, is in [Tools](/pi-straw-boss/docs/reference/how-it-works/tools/).

## Roles and status

| Command | What it does |
| --- | --- |
| `/boss` | Take over as this tab's main agent, even when it has one. |
| `/boss status` | Each tab's main agent and the towers. |
| `/boss tower` | Open this workspace's tower if none runs, and focus its tab. |
| `/boss tower <prompt>` | Write to this workspace's tower. |
| `/boss tower -w <workspace\|head> <subcommand>` | Act on another workspace's tower, as the tower's card and composer do. A write at another tower asks first. |
| `/boss tower … status`, `parked`, `leave`, `new` | The tower's state, its parked events, end its conversation with a note, start a new conversation. |
| `/boss tower … retry`, `deliver <id>`, `drop <id>` | Retry, deliver, or drop a parked event. |
| `/boss tower … [--answers W3] <message>` | Write a message; `--answers W3` marks a wait for you answered once the tower took it. |
| `/boss head [status\|leave\|new\|close\|<message>]` | Talk to the [head tower](/pi-straw-boss/docs/guide/head-tower/). A bare `/boss head` makes its workspace and focuses its tab. |
| `/boss head retry`, `parked`, `deliver <id>`, `drop <id>` | The head tower's notices and parked events. |
| `/boss head --answers W3 <message>` | A message that answers a wait. |

## Talking to sessions

| Command | What it does |
| --- | --- |
| `/boss send <name\|key> [--after] <text>` | Write to any session on the net as the boss, as the page's composer does. `--after` queues it for when the session is idle. Quote a name that has spaces: `/boss send "fix login" hi`. |
| `/boss stop <name\|key>` | Press Esc in a session, as the page's Stop does (asked in pi first). |
| `/boss answer` | List the dialogs other sessions wait on (a select, a confirm, or questions, with numbered choices). |
| `/boss answer <name\|key> [<choice number \| text> \| --cancel]` | Answer one, as the page does, through the same server checks. With no choice typed, pi asks. A secret is never answered from here: enter it in that session's terminal. |

## Memory and auto mode

| Command | What it does |
| --- | --- |
| `/boss memory [-w workspace]` | Read the tower's memory: standing instructions, decisions, waits, and the proposals waiting for you. |
| `/boss memory confirm P1`, `reject P1` | Confirm or reject a tower's proposal. |
| `/boss memory add standing\|decision <text>`, `edit S1 <text>`, `delete D1`, `resolve W1` | Change the memory yourself. |
| `/boss memory done\|choose\|decline W<n>` | Act on a wait, such as one parked by auto mode. |
| `/boss wait [-w workspace \| label \| head]` | List the wait cards open for you, and press one: done, an option, skip, reply to the tower, or start entering a secret. It sends the page's own press. The tower's standing pane takes the same as `/wait`. |
| `/boss auto` | Show the auto mode state and the last return list. |
| `/boss auto on`, `/boss auto confirm`, `/boss auto off` | Ask for auto mode and confirm it in the terminal; confirm a request the head tower staged; end it and print the return list. |

The GUI's Memory panel does the same as `/boss memory`. See [Tower memory](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/#tower-memory).

## Opening, closing, and stashing

| Command | What it does |
| --- | --- |
| `/boss open base <dir> [label]` | The page's + New base: a base in `<dir>` with one member. |
| `/boss open member [dir]` | A member beside this session, or in a tab of its own in `<dir>`. |
| `/boss open main <dir> [prompt]` | A main in a new tab of this base, with the prompt as its first message. |
| `/boss close` | Quit this session and close its pane. |
| `/boss close <name\|key>` | Quit another unit, a squad, or a base after a confirm. `unit:`, `squad:`, or `base:` before the name narrows a name that fits more than one. |
| `/boss close all [<workspace>]` | Quit a base's tower, mains, and members and close it, without stashing. Anything running that would be lost closes nothing, and every reason is listed. |
| `/boss stash [name] [--workspace <label\|id>]` | Put this base, or another one after a confirm, away and close it. |
| `/boss pop [name]` | Open a stashed base again, every pi resumed from its own session file in its old role. |
| `/boss dismiss [all\|<name>]` | Hide finished subagents from the net. |

`<dir>` is relative to this session's folder (`~` is home; quote a path with spaces); the server takes only folders under home.

## The sb server

| Command | What it does |
| --- | --- |
| `/boss server` | Show the sb server, and start it when it is down. |
| `/boss server stop` | Stop it on purpose, after a confirm. Nothing but a boss command starts it again. |
| `/boss server restart [reason]` | Restart it on the same port, after a confirm. Open pages reconnect by themselves. |
| `/boss server logs [n]` | The last `n` lines of its log (default and most 200). |

## The browser view

| Command | What it does |
| --- | --- |
| `/boss gui` | Open the net in the browser, from any session; starts the sb server when none runs and prints the URL. |
| `/boss gui stop` | Stop the GUI, until the next `/boss gui`. |
| `/boss gui rotate` | Give the GUI a new token, after a confirm: every phone is unpaired and the old address answers 403. |
| `/boss gui view`, `/boss gui view auto\|standard\|geek\|zen\|raven` | Show or set the default view for devices on Auto. Only this command sets it. |
| `/boss gui remote`, `/boss gui remote off` | Reach the GUI from a phone over your tailnet. See [Phone and remote access](/pi-straw-boss/docs/guide/phone/). |
| `/boss gui lan`, `/boss gui lan off`, `/boss gui lan reset` | Reach the GUI from a phone on the same Wi-Fi, without Tailscale. |
| `/boss gui devices`, `/boss gui unpair <id\|all>` | List the paired phones; unpair one or all. |

## Straw Link

| Command | What it does |
| --- | --- |
| `/boss link on` | Set up Straw Link on this computer, as the page's Set up button does. |
| `/boss link [status]` | This computer's teams and members, and the join requests waiting. |
| `/boss link decide <id> approve\|refuse` | Approve or refuse a join request. Approving an attended device asks you to pick the safety words the new computer shows. |
| `/boss link create <relay> <dir> [--share status\|presence] [--label x]` | Create a team for a project folder. The relay's token is asked on a masked screen. |
| `/boss link join <invite \| @file> [--project <dir>] [--share …] [--label x]` | Join a team; prints the four safety words for the inviter. |
| `/boss link invite <team> [unattended <device id>]` | Make an invite, as the page's Invite and Invite an unattended device do, after a confirm. Its text is drawn on a screen of its own, never in the chat. |
| `/boss link invite show\|cancel <hash>`, `link join cancel` | Show an open invite on a screen of its own, cancel it, or cancel the join in progress. |
| `/boss link leave <team> [--force]` | Leave a team, after a confirm. |
| `/boss link trust <device> reply\|forward\|dispatch` | Set what a message from a teammate's device may do, after a confirm that says what each level lets it do. |
| `/boss link role <team> <device> admin\|member` | Make a device of a team an admin or a member (an admin's act), after a confirm. |
| `/boss link remove <team> <device>` | Remove a device from a team (an admin's act). The confirm says the device can no longer read or send and the team key is replaced for the devices that stay. |
| `/boss link rotate <team>` | Replace the team's key for every device (an admin's act), after a confirm. |
| `/boss link confirms`, `link confirm <id> allow\|deny` | The confirms teammates' towers wait on, and their answer. |
| `/boss link asks`, `link answer <id> <number \| text>` | The questions unattended devices forwarded, and their answer. |
| `/boss link units [box]`, `link stop <box> <main \| handle start> [--interrupt] [reason]` | The units an unattended box reported, and asking the box to stop a main. |
| `/boss link operate`, `/boss link operate off` | The sessions this computer opened to operate unattended boxes; end them all and keep operate off. |

## From a shell

`node dist/server/cli.mjs` in the package's folder runs the sb server's own commands:

| Command | What it does |
| --- | --- |
| `cli.mjs status`, `cli.mjs logs` | The server's state, and its log. |
| `cli.mjs up`, `cli.mjs stop`, `cli.mjs restart` | Start the server and the GUI when they are down; stop or restart the server. |
| `cli.mjs serve` | Run the server in the foreground, as the link holder of an [unattended device](/pi-straw-boss/docs/guide/unattended-device/). |
| `cli.mjs up --dir <folder> --label <name>` | Desk mode, for a shell that shows the page itself: needs `STRAW_BOSS_DESK=1`. See [Desk mode](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/#desk-mode-up---dir). |
| `cli.mjs procs`, `cli.mjs procs reap --checkout <path>` | The workers the server knows; stop the processes that hold a checkout. |
| `cli.mjs train status\|check\|gate\|clear\|notices` | The [merge train](/pi-straw-boss/docs/guide/merge-train/)'s trains, slips, gates, and car notices. |

See [The sb server](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/), and [From a shell](/pi-straw-boss/docs/reference/how-it-works/from-a-shell/) for reading the net from a plain shell.
