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
| `call_peer` | a member, a main of any kind, a train (active from their runs) | Message a peer of the sb net under a header; sb finds it at the call, and a target that handed over is reached at its successor. `to`: `sender` (whoever wrote to you last), `caller` (who opened you: the opener, a successor's old main, the tower for its integrator, the integrator for a train), `main` (your tab's main; with `of`, another live main by exact name, todo item key, or tab id or label), `integrator` (the one integrator of your checkout's project). No target, or several matches, is refused with what was found (up to five candidates). `ask: true` stamps `reply=expected`; the answer comes as an intercom message. A main calling `main` without `of` is refused (that is itself); a tower uses `tower_send`/`tower_reply`. |
| `boss_watch` | a tab's main and trains (with tower runs on) | Have the sb server watch one unit of the net (`key`, `quiet`, `idle`, `until`, `stop`; no key lists your watches) and wake you with one line per change: at most one a minute per watch, the newest state only, 12 an hour, after your turn while you work. See [Watching with boss_watch](/pi-straw-boss/docs/guide/concepts/#watching-with-boss_watch). |
| `boss_pair` | a tab's main and trains | Pair a worker and a reviewer on review thread `T<n>` before dispatching them (`worker`, `reviewer`: the names you give `subagent`; `rounds` 1 to 3, default 3; `item`, optional: the todo uid or `<session8>#<id>` the pair works on, kept on the thread and in sb's event ledger); dispatch both with the line `Thread: T<n>`, and you are woken only by their two results when the thread closes. With `item`, the same todo check as `subagent` runs before the thread opens. See [Review threads with boss_pair](/pi-straw-boss/docs/guide/concepts/#review-threads-with-boss_pair). |
| `thread_post`, `thread_wait` | a subagent its main paired (active from its first run) | Post on the review thread (`to`, `tag`: `review`, `fix`, `done`, `blocked`, or `note`; `text`; `refs`), and wait for the posts that name you or for the thread's close. |
| `boss_duty` | a tab's main | Set its kind with a reason: `coordinator`, `integrator`, or `standing`. The kind's prompt reaches the main as a message, its system prompt stays as it is, and the kind shows on the page. |
| `boss_rename` | joined sessions | Name the session with a short phrase for its current work; a main's tab takes it as its label. A role label (a tower's glyph, `train <MMDDx>`) is refused. |
| `call_tower` | joined sessions and towers | Message this workspace's tower, or another workspace's, under a header. `why` is `milestone`, `shared`, or `blocked`; `reply: false` for a notice. sb records a `milestone` in the tower's logbook and wakes the tower only when it answers the tower's request; it records a `shared` heads-up and wakes the tower only when it overlaps another open heads-up or a main's board, else answers "recorded, no clash seen" ([The logbook](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/#the-logbook)). `waitsOn {device, owner?, what}` with `blocked` says it waits on a teammate's device (`cancel: true` with `milestone` withdraws it); `linkWait {id, state}` takes, answers, or declines a teammate's wait on this computer, sends a note in its thread to the main there that waits (`note`, which leaves it open), and as the boss's delegate approves a teammate's card for its boss (`done`) or leaves it to that boss (`escalated`, with `blocked`); `standing {device, what?}` sends the message to that device's standing main instead of the tower, a question with `blocked` (its answer comes back) or a notice with `milestone`. `worker {device, branch, base?, model?, points?, label?}` sends the message as the whole brief of a worker on that teammate's box (one whose caps list `tower.worker` and that trusts you at `dispatch`): the box opens it in a worktree of its own, and its final report, or the box's refusal, comes back to you as a `link_reply` ([A worker opened for the device](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/#a-worker-opened-for-the-device)). `worker {device, resume: "<uuid>", branch?, model?, points?}` sends the message as a follow-up to a worker that ended: the full session id is the one its receipt's `Session:` line names (kept 7 days), and the box must list `tower.worker.resume`. `boss {question, options?}` with `blocked` is a decision only you can make: with auto mode off, sb asks you in that main's own pane and in the GUI (pick an option or type your own answer, wherever you are) and your answer goes back to the main, not to the tower; under auto mode it goes to the tower, parked until you are back. See [When a main calls the tower](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/#when-a-main-calls-the-tower) and [Waits between devices](/pi-straw-boss/docs/reference/how-it-works/how-it-works/#waits-between-devices). |
| `boss_broadcast` | joined sessions and towers | Message a tab, a workspace, every tower, or every session, under a header naming every recipient. |
| `board_set` | a tab's main | Override its own work board entry (one line and up to 8 checklist items); `auto: true` hands it back to the auto-fill, `clear: true` deletes it; `snooze: {why, for?, watch?, todo?}` holds its stale reminder for a span (`30m`) or until one of its `boss_watch` watches next changes, for the whole main or one todo. |
| `ledger_sweep` | scheduled head run only | Run the server's state prune and the configured ledger janitor; return the items that the head should forward. Takes no arguments. |
| `boss_server` | joined sessions | The sb server's `status` (also with it down), its `logs` (up to 200 lines), or `restart` with a reason. Refused while the boss stopped the server or a train runs, at most once a minute, and never in a remote turn. |
| `sb_doctor` | joined sessions and towers | This session's own tools and loads: whether the expected tools (`subagent*`, `intercom`, `todo`, `MonitorCreate`) are registered and active, which subagent host registered them (sb's own, stood down for pi-herdr-agents and why, or off) with its Maestro build, whether it is current, and what to do: H1 (loaded nothing: hand over), H2 (inactive: `/boss doctor fix`), stale (reload or hand over). Call it before concluding a tool is missing; see [The doctor](/pi-straw-boss/docs/reference/how-it-works/the-doctor/). |
| `subagent` | every pi session, joined or not, with or without todos | Launch one worker in a Herdr split pane: `name`, `task`, and optionally `agent` (a role), `model` (an exact id, a fallback list, or `task:<category>`), `thinking`, `cwd`, `item` (the todo it works on; a quick scout needs none), `solutionSpace`, `systemPrompt`, `skills`, `tools`, `fork`, `interactive`. It runs one task, exits, and its result arrives as a message; never poll. `persistent`, `notify`, `worktree` and `accept` are refused with what to do instead. With `item`, sb first checks that todo: a `blockedBy` cycle refuses the launch; a missing or vague anchor, or a deleted or unknown blocker, adds a warning to the result. See [The subagent host](/pi-straw-boss/docs/reference/how-it-works/the-subagent-host/). |
| `subagent_cancel` | the session that launched the worker | End a running worker (`id` or `name`); one `cancelled` result follows, and no fallback model starts. |
| `subagent_resume` | every pi session | Continue a saved worker session in a new pane (`sessionPath`, `name`, `message`, `autoExit`): answer its `caller_ping`, follow up, or pick up a worker that ended without a result. |
| `subagents_list` | every pi session | The roles you can launch, and where each comes from. |
| `sb_ward` | a tab's main (with tower runs on) | Ward a worker that runs in a plain pane (`pane`, `item`, `until`, `stop`), in place of a Herdr monitor: the sb server wakes you once when it finished (reported to you, or its turn ended and nothing of it ran for a minute), is blocked (a dialog, or Herdr blocked), or is dead (pane gone, pi left); idle while its own monitor or loop runs is no wake. Read only. See [Ward a plain pane](/pi-straw-boss/docs/reference/how-it-works/process-hygiene-and-slots/#ward-a-plain-pane). |
| `link_request` | every session on an attended computer where Straw Link is set up, and a local tower run | Ask for a Straw Link action (create, invite, join, trust, leave, remove, role, rotate, hold) with a reason. It never runs unasked: the boss approves it in a dialog. `release` of the caller's own hold of a box runs with no dialog ([Holding a teammate's box](/pi-straw-boss/docs/reference/how-it-works/how-it-works/#holding-a-teammates-box)). |
| `boss_open_main` | towers | Open a tab with a new main agent for a request no session owns. `role: "train"` opens a train; `role: "integrator"` sends a car slip to the project's one integrator, opening it when none runs. `duty: "standing"` opens a main of kind standing (default coordinator). In an ally run at `dispatch`, `role: "worker"` opens a worker on the `worker:` slip the run's device sent, a resume slip too (`branch` picks one of several); the sb server answers the device either way. See [Merge train](/pi-straw-boss/docs/guide/merge-train/). |
| `boss_close_main` | towers | Close a main this tower opened, or one that handed over once its successor is live, once nothing runs in it; never a standing main or a boss-opened main that did not hand over, which only the boss closes. With `pane`, close a dead agent pane (its pi gone, a bare shell); with no argument, list them. |
| `boss_revive_main` | towers (pi towers and local tower runs) | `list` the workspace's dead and quit mains; `revive` one as itself (same session, new tab, its role, kind, name, board, todos, and waits), with a reason. Members, towers, link-opened mains, and live sessions are refused. |
| `boss_handover` | a tab's main | Open its own successor for a session rotation: one new tab at a time, under its name and kind. The first prompt names the `handoff` file and, when available, the adjacent `.todos.json` file to import. The list includes completed tasks and their evidence but not deleted tasks. The workspace's tower hears of it. Once the successor tells the old main it took over and nothing of the old main runs, sb closes the old main and its pane, under auto mode too, and forwards a subagent result that reaches it meanwhile to the successor. Refused for a main a teammate's device opened. |
| `boss_wrap` | a tab's main (not a standing one, a train, a tower, a main opened for a teammate's device, or a teammate's turn) | Wrap up when the work is done (`summary`, one paragraph): asks you in the main's own pane, so Herdr shows it waiting; on yes it sends the summary to the workspace's tower as a milestone (and to whoever a tower opened the main for), clears its board, and closes the session and its own pane as `/boss close` does, never its tab: a pane beside it and the tab stay, and Herdr closes the tab once no pane is left. Refused with an open todo, a running monitor, loop, `boss_watch`, or subagent, and under auto mode. A coordinator or integrator main idle 30 minutes gets one nudge from sb asking whether its work is done; none under auto mode. |
| `tower_list` | towers | Every workspace's tower, who a message for it reaches, its state, and what its tabs work on (each tab's main with its kind). |
| `tower_send` | towers | Message one other tower (by workspace id or label) or all of them; with `device`, the tower of a teammate's computer: leaving `reply` out binds the one main that called the run expecting an answer, `reply: false` is a notice, `waitsOn: {event}` forwards a main's wait on that device, and `standing: "question"` or `"notice"` (in a run) goes to that device's standing main instead; an ally run sends notices only. |
| `board_read` | towers, mains; members get `towers` alone | The work board: what each main is doing and how far it is, here and on teammates' computers, the open waits between this computer and teammates' devices (`waits`), `towers`: each tab's main agent and its kind, this workspace's tower, the head tower, and the other towers (`boss_status` before 0.83.0), and `logbook`: the milestones and heads-ups sb recorded for this workspace's tower in the last day, and the heads-ups open elsewhere; for a main, its review `threads`, and with `thread` one thread's posts. Each main's row and section `capacity` carry the [device's capacity](/pi-straw-boss/docs/reference/how-it-works/how-it-works/#device-capacity): points in use, the budget, the load, ready work, and paused mains. |
| `tower_memory` | local tower runs | Keep what outlives the run: a standing instruction or a decision quoted from the boss's own message, and the tower's waits, including a wait on the boss as a card. Where the device names a boss's delegate (`link.delegate` in config.json, `delegate` in an unattended device's policy file), a card goes to it first unless it is marked `bossOnly`, is a secret, or a train or an integrator raised it. |
| `boss_wait_ask` | mains, local tower runs, the head tower | Have sb show you open wait cards in the terminal, one after another: `ids` (1 to 4 `W<n>`), or none for every open card in its scope (a main the cards it raised, a tower run its tower's, the head any). sb draws each card as `/boss wait` does; the agent words and chooses nothing, and only your keys press. Refused while auto mode is on, on an unattended device, without a screen, and in a tower run unless your last words in it came from its pane. |
| `tower_reply` | tower runs, not the head tower's | Answer one local session (a main or a member) by its intercom name or session id, under the tower's header. `forward` carries a car slip's event id to an integrator. |
| `tower_done` | tower runs | End this run with a handoff note (one item per line, up to 1,200 characters) for the next run; `wakeAfter` (5 to 240 minutes, local runs only) asks for a follow-up run. Refused while events are still waiting for the run, or while a main's wait on a device is neither forwarded nor answered. |
| `ally_escalate` | ally runs | Hand an item of the sender's message (a wait on someone here, a local main it names, work no local main owns, an incident) to the wait router, which tells a main or puts it on the boss's list. Free at every level; at most 5 per run. |
| `boss_auto` | the head tower | Start or end [auto mode](/pi-straw-boss/docs/guide/auto-mode/) at once, with no confirm, on the boss's own words in the turn it answers (the server reads them itself). |
| `train_car` | the integrator and trains (registered in a train, and in a session whose project's apps.json has an app with `integration`) | Set a car's state (`received`, `returned`, `dropped`, `landed`); the sb server tells the car's coordinator. Its `car` is the car's first ticket; the slip's `car:` (or `app:`) names the app, and `app` or `head` (40 hex) picks one car when a ticket is on two. A train sets its cars' `returned`, `dropped` and `landed`; the integrator sets `received` or `returned` at receipt, and `returned`, `dropped` or `landed` of a car it received once that car's train is gone. |

The full table, with every argument, is in [Tools](/pi-straw-boss/docs/reference/how-it-works/tools/).

## Roles and status

| Command | What it does |
| --- | --- |
| `/boss` | Take over as this tab's main agent, even when it has one. |
| `/subagent <agent> <task>` | Launch a subagent with the named role. Use `/subagent list` to see the roles. |
| `/boss status` | Each tab's main agent and the towers. |
| `/boss asks` | The questions waiting on you on this computer: `call_tower`'s boss questions, the open wait cards, a teammate's waits raised to you, and units that wait on `ask_user_question`, each as `Q3 · 7m · asker · where · subject` with the todo it blocks, this session's and its subagents' first. The todo panel draws the same rows through `straw-boss:ask-rows:v1`; see [Questions waiting on you](/pi-straw-boss/docs/reference/how-it-works/browser-view/#questions-waiting-on-you). |
| `/boss board` | The work board as text: each main's line, its done count and age, the stale and the ended ones (this computer only). |
| `/boss board log` | The logbook: the milestones and heads-ups sb recorded for every tower of this computer in the last day, each with its sender, its end for a heads-up, and whether it woke the tower. |
| `/boss cars` | Where this session's cars are: each under its todo (or Other cars; an integrator's trains under Trains), as `📮 sent`, waiting to depart with its rule, on its train's stage (`🚂 1127l ▰▰▰▱▱▱▱ merge 12m · waits 1127j`, the stage as the train names it), or ended in the last 30 minutes. The same rows the todo panel draws through `straw-boss:car-rows:v1`; see [Car rows](/pi-straw-boss/docs/reference/how-it-works/how-it-works/#car-rows). |
| `/boss tower` | Open this workspace's tower if none runs, and focus its tab. |
| `/boss tower <prompt>` | Write to this workspace's tower. |
| `/boss tower -w <workspace\|head> <subcommand>` | Act on another workspace's tower, as the tower's card and composer do. A write at another tower asks first. |
| `/boss tower … status`, `parked`, `leave`, `new` | The tower's state, its parked events, end its conversation with a note, start a new conversation. |
| `/boss tower … retry`, `deliver <id>`, `drop <id>` | Retry, deliver, or drop a parked event. |
| `/boss tower … [--answers W3] <message>` | Write a message; `--answers W3` marks a wait for you answered once the tower took it. |
| In a tower's viewer (`towerRuns.headless`) | A line goes to the tower. Typed alone: `/stop` ends the run's turn; `@<workspace> <text>` sends your words straight to that tower; `/yes N`, `/no N`, `/pick N <choice>` answer a run's dialog. A paste is never one of these. See [Headless runs](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/#headless-runs). |
| `/boss head [status\|leave\|new\|close\|<message>]` | Talk to the [head tower](/pi-straw-boss/docs/guide/head-tower/). A bare `/boss head` makes its workspace and focuses its tab. |
| `/boss head retry`, `parked`, `deliver <id>`, `drop <id>` | The head tower's notices and parked events. |
| `/boss head --answers W3 <message>` | A message that answers a wait. |

## Talking to sessions

| Command | What it does |
| --- | --- |
| `/boss send <name\|key\|#todo> [--after] <text>` | Write to any session on the net as the boss, as the page's composer does. `#63` or a todo uid writes to the owner of that todo of this session's list; a subagent is named as Herdr shows it. `--after` queues it for when the session is idle. Quote a name that has spaces: `/boss send "fix login" hi`. |
| `/boss stop <name\|key>` | Press Esc in a session, as the page's Stop does (asked in pi first). |
| `/boss answer` | List the dialogs other sessions wait on (a select, a confirm, or questions, with numbered choices). |
| `/boss answer <name\|key> [<choice number \| text> \| --cancel]` | Answer one, as the page does, through the same server checks. With no choice typed, pi asks. A secret is never answered from here: enter it in that session's terminal. |

## Memory and auto mode

| Command | What it does |
| --- | --- |
| `/boss memory [-w workspace]` | Read the tower's memory: standing instructions, decisions, waits, and the proposals waiting for you. |
| `/boss memory confirm P1`, `reject P1` | Confirm or reject a tower's proposal. |
| `/boss memory add standing\|decision <text>`, `edit S1 <text>`, `delete D1`, `resolve W1` | Change the memory yourself. |
| `/boss memory done\|choose\|decline W<n>` | Act on a wait. A card parked by auto mode is not here when it ends: it went back to whoever raised it. |
| `/boss wait [-w workspace \| label \| head]` | List the wait cards open for you, and press one: done, an option, skip, reply to the tower, or start entering a secret. It sends the page's own press, and after a press, a skip, or a reply opens the next card that still waits (**Next card** and **All cards** are among a card's acts). The tower's standing pane shows the cards by itself, one after another: ↑↓ or a digit marks a row, Enter presses it, ←→ go to another card, Esc gives the keys back to the message line, and `/wait` brings the cards back; no tower run starts while you answer (until about a minute after your last card key, 5 minutes at most). Where keys are not reported (a pipe, `TERM=dumb`, Windows) `/wait` is the numbered picker. |
| `/boss auto` | Show the auto mode state and the last return list. |
| `/boss auto on`, `/boss auto confirm`, `/boss auto off` | Ask for auto mode and confirm it in the terminal; confirm a request that waits for your confirm; end it, send every parked card back to whoever raised it, and print the return list. |

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
| `/boss server restart [reason]` | Restart it on the same port, after a confirm, which names any train that runs. Open pages reconnect by themselves. |
| `/boss server logs [n]` | The last `n` lines of its log (default and most 200). |
| `/boss locale` | Show sb's language (English or Traditional Chinese) and where it comes from: `locale` in `config.json`, else the environment. |
| `/boss locale zh-TW` · `en` · `auto` | Set it in `config.json`, or take it from the environment again (`auto`). The server and `/boss` commands follow at once, a tower prompt from its next start; cards already written keep theirs. See [Language](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/#language). |

## Roles

| Command | What it does |
| --- | --- |
| `/boss roles-check [folder]` | Check each role's `tools:` names against this session's tools, plus the names only a subagent has (`caller_ping`, `subagent_done`, `thread_post`, `thread_wait`). A name the session lacks, or one only a parent has (sb's own tools, pi-herdr-agents' worktree tools), fails. With no folder it reads sb's own `roles/`; before a release, name the checkout's `roles/`. It starts nothing, and refuses in a session started with `--tools` or `--exclude-tools`. |
| `/boss doctor`, `/boss doctor fix` | The doctor's report for this session; `fix` makes the expected tools that are registered but inactive active again. Each session start also checks once and warns when an expected tool is missing. |

See [The role pack](/pi-straw-boss/docs/reference/how-it-works/the-role-pack/).

## The browser view

| Command | What it does |
| --- | --- |
| `/boss gui` | Open the net in the browser, from any session; starts the sb server when none runs and prints the URL. |
| `/boss gui stop` | Stop the GUI, until the next `/boss gui`. |
| `/boss gui rotate` | Give the GUI a new token, after a confirm: every phone is unpaired and the old address answers 403. |
| `/boss gui view`, `/boss gui view auto\|standard\|geek\|raven\|storybook` | Show or set the default view for devices on Auto. Only this command sets it. Zen is a mode, entered with the Zen button in the page's header, so `zen` is refused. |
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
| `/boss link hold <box> [--main <name\|key>] [--hours n]`, `link release <box>`, `link holds` | Hold a teammate's unattended box for a main here (after a confirm; this session unless `--main` names another), release it, and list this computer's holds with whether each box honours it. |
| `/boss link held`, `link held end` | On a held box: which teammate holds it, and ending the hold here (after a confirm; that device is told). |
| `/boss link operate`, `/boss link operate off` | The sessions this computer opened to operate unattended boxes; end them all and keep operate off. |

## From a shell

`node dist/server/cli.mjs` in the package's folder runs the sb server's own commands:

| Command | What it does |
| --- | --- |
| `cli.mjs status`, `cli.mjs logs` | The server's state, and its log. |
| `cli.mjs prune --dry-run` | Count which stale records, ended train files, and missing tower folders the server would prune. Writes nothing to the state directory. |
| `cli.mjs up`, `cli.mjs stop`, `cli.mjs restart` | Start the server and the GUI when they are down; stop or restart the server. `restart`, and the upgrade or desk-switch restart of `up`, are refused while a train runs; `--force` with `--reason` restarts anyway. |
| `cli.mjs serve` | Run the server in the foreground, as the link holder of an [unattended device](/pi-straw-boss/docs/guide/unattended-device/). |
| `cli.mjs up --dir <folder> --label <name>` | Desk mode, for a shell that shows the page itself: needs `STRAW_BOSS_DESK=1`. See [Desk mode](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/#desk-mode-up---dir). |
| `cli.mjs watch <key> [--idle 20m] [--quiet 30m] [--deadline <ms>]` | One JSON line per change of a unit, a main, or a teammate device's `link:` key, for `MonitorCreate`; ends on `gone` or `expired`. |
| `cli.mjs procs`, `cli.mjs procs reap --checkout <path>` | The workers the server knows; stop the processes that hold a checkout. |
| `cli.mjs pane close <pane> [--checkout <root>] [--force]` | Close a dead agent pane of this workspace (the table `boss_close_main` uses decides; `--force`, the boss's alone, closes any other) and check it is gone (closed again while Herdr still lists the same terminal, three closes at most), then stop what it left: its shell's tree, one verified process at a time, and with `--checkout` (the root of a linked worktree) the processes that work there, never this command. Prints one JSON line with what is `left`; exit 1 when the pane stays or something is left. See [A checked pane close](/pi-straw-boss/docs/reference/how-it-works/process-hygiene-and-slots/#a-checked-pane-close). |
| `cli.mjs ward <pane>` | Retired: refuses and points to `sb_ward` (exit 1). A ward is set, listed, and stopped only by the main's own pi process, which carries its registration secret; a shell holds none. See [Ward a plain pane](/pi-straw-boss/docs/reference/how-it-works/process-hygiene-and-slots/#ward-a-plain-pane). |
| `cli.mjs doctor --session <id\|prefix\|pane> [--json]` | The doctor for another session from outside it: a fresh load by pi's loader, the tools its session file was refused, its pi's start against the install. Exit 1 on a fault. |
| `cli.mjs train status\|check\|gate\|clear\|end\|notices` | The [merge train](/pi-straw-boss/docs/guide/merge-train/)'s trains, slips, gates, and car notices. `status --state live,stale,ended,unreadable` keeps those rows. `status --watch [--every <seconds>]` looks again every 60 seconds (or as given, 10 to 2147483) and prints one JSONL `progress` line per look, changed or not, so a `MonitorCreate` on it does not time out while nothing changes; it ends with exit 1 when its stdout closes. `check` runs from the project or any folder in it, requires the app's `integration.accept` without `--app-accept`, and checks a slip's `head:` is a known commit and the tip of its branch on origin. `end --project P --train CODE --outcome landed --commit SHA` (or `--outcome none`) `--reason TEXT --evidence TEXT` ends a stale train (one that still holds a deploy target is cleared of it first). |

See [The sb server](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/), and [From a shell](/pi-straw-boss/docs/reference/how-it-works/from-a-shell/) for reading the net from a plain shell.
