---
title: Quick start
description: See the net work in four steps.
---

1. **Open pi in a Herdr tab and give it work.** It joins the net by itself. When its work grows, it promotes itself to the tab's main agent, which also opens the workspace's tower. Type `/boss` to take over as the tab's main yourself.
2. **Type `/boss status`** to see each tab's main agent and the towers.
3. **Type `/boss tower`** to open the workspace's tower and watch its dashboard. It also opens by itself when agents start to collide. You do not need to talk to it.
4. **Type `/boss gui`** from any session to see the whole net in your browser.

![The tower's dashboard in the terminal: this net's tabs, agents, and subagents, and the other towers](/pi-straw-boss/docs/img/tower-dashboard.png)

## The tower runs on its own

The tower service of the sb server is on by default: it wakes for events and keeps a small memory, so you do not have to talk to it.
`/boss tower <prompt>` writes to it, `/boss memory` shows its memory, and `towerModel` in the [configuration](/pi-straw-boss/docs/reference/configuration/) gives it a lighter model.
How a run works, and what a handoff note is, is in [How a tower runs](/pi-straw-boss/docs/guide/concepts/#how-a-tower-runs).

## Next

- [Concepts](/pi-straw-boss/docs/guide/concepts/): who is a member, a main, a tower, and the head tower, and every kind of agent and run.
- [The browser view](/pi-straw-boss/docs/guide/browser-view/): the map, comms, alerts, and the Zen view.
- [Commands](/pi-straw-boss/docs/reference/commands/): every tool and `/boss` command.
