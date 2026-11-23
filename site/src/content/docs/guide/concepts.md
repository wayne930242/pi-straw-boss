---
title: Concepts
description: Members, main agents, towers, the head tower, every kind of agent and run, and how they talk.
---

pi-straw-boss gives the agents you run across Herdr tabs a light chain of command.
Joining is automatic; the chain of command is earned.

![Herdr with pi-straw-boss: the sidebar's net view of every workspace, tower, main agent, and subagent, beside a main agent at work](/pi-straw-boss/docs/img/herdr-window.png)

## Who is who

```mermaid
flowchart TD
  you(["You"]) -->|"/boss head"| head["Head tower<br/>1 per computer"]
  head -->|tower_send| tower["Tower<br/>1 per workspace"]
  tower -->|boss_open_main| main["Main agent<br/>1 per tab"]
  tower -->|boss_open_main| train["Train"]
  member["Member"] -.->|boss_promote| main
  main -->|call_tower| tower
  main -->|subagent| sub["Subagents<br/>kinds in the table below"]
```

| Role | Who | What it does |
| --- | --- | --- |
| **Member** | Every pi in a Herdr tab, from its start | Works on its own. With a main in the tab, it tells the main before it dispatches subagents. |
| **Main agent** | One per tab: the member that promotes first, or you with `/boss` | Plans, dispatches workers, checks their results, and asks you before it merges or deploys. |
| **Tower** | One per workspace, in its own tab pinned first | Coordinates the mains of its workspace and the other towers, and opens a tab with a new main for work no session owns. It never asks you. |
| **Head tower** | One per computer, belonging to no project | Takes your instructions and hands each to the tower of the workspace that owns it. See [The head tower](/pi-straw-boss/docs/guide/head-tower/). |
| **Train** | One per merge train, named `train <MMDDx>`, opened by the tower | Merges a batch of reviewed branches and ends. See [Merge train](/pi-straw-boss/docs/guide/merge-train/). |
| **Subagent** | Launched with [pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents), or a session in a Herdr worktree workspace | Never joins the net. The session that launched it speaks for it, and every view lists it under that session. |

The `/boss` commands and tools that move between these roles are in [Commands](/pi-straw-boss/docs/reference/commands/).

### Promotion

- An agent whose work grows (several steps, dispatching workers, more than one app) calls `boss_promote`.
- A member that dispatches a subagent is promoted first, automatically.
- A tab has one main. Nobody takes it over except you, with `/boss`.
- A main never demotes. When its session ends, the tab has no main until a member promotes.

### When the tower opens

A tower opens in its own tab when agents start to collide:

- a member dispatches a subagent, or an agent promotes itself;
- a workspace has two members while another workspace already has a tower;
- you type `/boss tower`.

Mains and the tower go together: a tower that opens promotes each tab's earliest member, and a tower that quits turns every main back into a member (their subagents stay).

## Kinds

A main and a subagent each have a **kind**, shown as a word beside the name and as the unit's icon in the [browser view](/pi-straw-boss/docs/guide/browser-view/) and the Herdr sidebar.
[Icons](/pi-straw-boss/docs/guide/icons/) draws every icon and lists the sidebar's glyphs.

### Kinds of main

A main sets its kind with `boss_duty`.

| Kind | For | Icon |
| --- | --- | --- |
| `coordinator` (default) | Plans and dispatches work | Ship's wheel |
| `integrator` | One project's [merge trains](/pi-straw-boss/docs/guide/merge-train/) | Two arrows joining |
| `standing` | One system or machine, with no end | Lighthouse |
| *train* (a role, not a `boss_duty` kind) | One merge train | Locomotive |

The GUI shows `standing` as **on watch** (zh-TW 值守); this page keeps the code's word.

### Kinds of subagent

Straw Boss reads the kind from the name of the pi-herdr-agents role the subagent was launched with.
The roles come from pi-herdr-agents and its role packs; what a role does is in its own definition.

| Kind | Role names | Typical job | Icon |
| --- | --- | --- | --- |
| `worker` | `worker` | Implements a task | Wrench |
| `scout` | `scout` | Investigates and reports | Binoculars |
| `planner` | `planner` | Plans and designs | Pencil and ruler |
| `reviewer` | `reviewer`, `visual-tester`, `adversarial-reviewer` | Reviews a change or checks a screen | Magnifier |

Any other role name stays a plain subagent.

A main dispatches any of them without a plan; its prompt asks for a todo before each worker.
At most 4 workers of one main run at once: a fifth is refused with `sb: 4 workers run for this main already` until a result comes back. Scouts, planners, and reviewers are not counted.

### Watching with boss_watch

A main or a train asks the sb server to watch one unit of the net with `boss_watch`: a main with its monitors and todos, a train, another subagent, or a teammate device's `link:` key.
The server wakes the main with one line when the unit changes state, stalls, idles, or ends; no subagent watches, and the main checks nothing in its own turns.

- `key`: the unit's session id or its key in the net;
- `quiet` and `idle` (`30m`, `2h`; at least `1m`): when a stall or an idle spell matters;
- `until`: how long the watch lasts (default `6h`, at most `48h`); `stop: true` ends it, and no key lists your watches.

Each watch sends at most one message a minute, the newest state only, and a session gets at most 12 an hour; while the main works, the message waits for the end of its turn.
The watches live in the sb server, so they survive a `/reload` and a server restart.
`boss_watch` needs tower runs on (`towerRuns.enabled`), because the workspace's tower identity sends the lines.

0.83.0 retired the `watchdog` subagent and `cli.mjs watch`.
The rules are in [Watches](/pi-straw-boss/docs/reference/how-it-works/the-role-pack/#watches).

### Review threads with boss_pair

A reviewed change no longer goes through the main once per finding. The main pairs a worker and a reviewer with `boss_pair` before it dispatches them, writes both briefs, and puts the line `Thread: T<n>` in each task.
The two children post to each other on that thread (`thread_post`, `thread_wait`) through the sb server, and the main is woken only by their two results when the thread closes.

- `worker` and `reviewer`: the names the main then gives `subagent`;
- `rounds`: how many repair rounds the thread allows, 1 to 3 (default 3).

Only the reviewer posts `fix` (one repair round each) and `done` (its approval, which closes the thread); either member may post `blocked`, which closes it too.
A `fix` past the round cap, 2 hours without a post, or a member that ended without a close makes the server close the thread `blocked`.
Only the main's two paired children get the thread tools, from their first run; any other child, and a child of another main, has none.
`board_read` lists the main's threads, and `board_read` with `thread` shows one thread's posts.
The rules are in [Review threads](/pi-straw-boss/docs/reference/how-it-works/the-role-pack/#review-threads).

## How a tower runs

A tower is a service of the [sb server](#the-sb-server), not a long-lived pi.
Its pane stands by, and the server wakes it for each event with a **run**: a pi session that does the work and ends with a **handoff note** for the next run.

```mermaid
flowchart TD
  ev(["Event"]) --> q["Tower queue"]
  q --> who{"Who sent it?"}
  who -->|"you"| boss["Boss conversation<br/>resumes your last session"]
  who -->|"a session here"| event["Event run<br/>a fresh session"]
  who -->|"a teammate's device"| ally["Ally run<br/>a fresh session"]
  boss --> done(["tower_done<br/>handoff note, then stands by"])
  event --> done
  ally --> done
```

| Run | Wakes for | Notes |
| --- | --- | --- |
| **Event run** | A main's `call_tower`, or a notice | Starts fresh; the handoff note carries over what matters. |
| **Boss conversation** | Your message: `/boss tower <prompt>` or the GUI's composer | Resumes your last session with that tower. |
| **Ally run** | A teammate's [Straw Link](/pi-straw-boss/docs/guide/straw-link/) message | Works at the sender's trust level; the GUI shows it as an *ally run*. |

What has to outlive a run sits in the tower's memory: your standing instructions, your decisions, and its open waits on you.
A tower can only propose a standing instruction or a decision; it takes effect when you confirm it.
See [Tower memory](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/#tower-memory).

## Talking

`call_tower` is a main's only message to its tower, at three points:

| `why` | When | Example |
| --- | --- | --- |
| `milestone` | Something landed | A branch merged |
| `shared` | Before it changes something outside its tab | A port, a database, a shared branch, a deploy target |
| `blocked` | It waits on someone outside its tab | A decision, a deploy window |

- **`tower_list` and `tower_send`**: a tower lists every workspace's tower and writes to one or all of them. A workspace without a tower is reached through its mains, else its members.
- **`boss_broadcast`**: a message to a tab, a workspace, every tower, or every session.
- Every such message opens with a header the code writes: who sent it, in what role, to whom, and whether a reply is expected. See [Talking between towers](/pi-straw-boss/docs/reference/how-it-works/how-it-works/#talking-between-towers).

## What a tower knows

- **The work board.** A main's entry fills itself from its todo list and its name; `board_set` overrides it. A tower reads every main's entry with `board_read`, here and on teammates' computers. Teammates see only an automatic entry's name and progress. See [The work board](/pi-straw-boss/docs/reference/how-it-works/how-it-works/#the-work-board).
- **The digest.** Joins, subagent launches, and renames in its workspace since its last run, read once and cleared.
- **Its memory.** See above.
- **The dashboard.** A live view in the tower's tab of who joined and what they and their subagents are doing.

A main a tower opened for a request reports to the sender and the tower when it is done, and the tower closes it with `boss_close_main` once nothing runs in it.

## The sb server

One background process per computer, the sb server, runs the towers, serves the browser view, and holds the Straw Link connection, so none of them depends on which pi session happens to run.
Any pi session starts it when it is down.
`/boss server` shows it, and `boss_server` lets an agent read its log or restart it with a reason.
See [The sb server](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/).

## Housekeeping

Straw Boss also keeps tabs tidy, asks stranded subagents to report, resumes subagents a Herdr restart brought back as plain pi sessions ([Orphaned subagents](/pi-straw-boss/docs/reference/how-it-works/orphaned-subagents/)), and stops stray processes ([Process hygiene](/pi-straw-boss/docs/guide/process-hygiene/)).

The full rules are in [Roles and the tower](/pi-straw-boss/docs/reference/how-it-works/how-it-works/).
