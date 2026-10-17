# pi-straw-boss

**Many pi agents, one project, no collisions.** pi-straw-boss gives the agents you run across [Herdr](https://herdr.dev) tabs a light chain of command: a main agent per tab, a tower per workspace, and a live view of who is doing what.

<!-- /boss gui screenshot goes here -->

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

## Why

Run a few agents on the same project and they start stepping on each other: two dev servers on one port, two branches editing the same migration, and no agent knows the others exist. pi-straw-boss lets them find each other and coordinate, without a scheduler or a new service.

- **Opt-in net.** Each session is asked once whether its work shares resources or needs to collaborate. Only those that say yes join.
- **A main agent per tab.** The first to join a tab coordinates it; `/boss` takes over.
- **A tower per workspace.** It opens on demand in its own tab, pinned first, and coordinates the main agents and the other towers. You don't need to talk to it.
- **A live dashboard** in the tower: who joined, and what they and their subagents are doing.
- **Broadcast** to a tab, a workspace, every tower, or every session.

## Install

```bash
pi install npm:pi-straw-boss
```

You need pi running inside Herdr 0.9.4 or newer, and [pi-intercom](https://www.npmjs.com/package/pi-intercom) 0.17.1 or newer. [pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents) is optional: with it, subagents show up under the session that launched them.

## Quick start

1. Open pi in a Herdr tab and give it work. When the work needs to share or coordinate, the agent joins the net. You can also type `/boss`.
2. Type `/boss status` to see each tab's main agent and the towers.
3. Type `/boss tower` to open the workspace's tower and watch its dashboard. Agents open it themselves when they call it.

## Tools and commands

| Name | What it does |
|---|---|
| `boss_join` | Join this tab's net. |
| `boss_status` | Main agents, this workspace's tower, and the other towers. |
| `call_tower` | Message this workspace's tower, or another workspace's. |
| `boss_broadcast` | Message a tab, a workspace, all towers, or every session. |
| `/boss` | Join and become this tab's main agent. |
| `/boss status`, `/boss tower` | Show the status; open and focus the tower. |

Subagents and sessions in Herdr worktree workspaces never join: the session that launched them speaks for them. Outside Herdr the extension does nothing.

## Learn more

[How it works](docs/how-it-works.md) covers roles, the tower, the dashboard, what the extension writes, and how Claude Code or Codex agents can find a tower.

## License

MIT
