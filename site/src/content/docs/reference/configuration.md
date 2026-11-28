---
title: Configuration
description: The settings file, the project's apps.json, and the environment variables pi-straw-boss reads.
---

pi-straw-boss works with no configuration.
Everything below is optional.

## `config.json`

The settings file is `<agentDir>/straw-boss/config.json`, where `<agentDir>` is `PI_CODING_AGENT_DIR`, else `~/.pi/agent`.

```json
{
  "towerModel": "provider/model-id",
  "headModel": "provider/model-id",
  "towerRuns": { "enabled": true, "max": 4 },
  "integration": "on",
  "locale": "zh-TW",
  "stallWatch": { "cpuMinutes": 5, "silentMinutes": 30 },
  "capacity": { "budget": 20 },
  "subagentNudge": { "idleMinutes": 10, "max": 2 },
  "link": {
    "relay": "https://relay.example",
    "trust": { "<device id>": "forward" }
  }
}
```

| Key | Default | What it does |
| --- | --- | --- |
| `towerModel` | pi's default model | The model a tower runs. The tower only routes and coordinates, so it can run a lighter model. Read at each tower start. |
| `headModel` | `towerModel` | The model the [head tower](/pi-straw-boss/docs/guide/head-tower/) runs. |
| `towerRuns.enabled` | `true` | The tower service: a tower is a run that wakes for its events and ends with a handoff note. `false` keeps resident towers. A file that cannot be read or parsed also means on, and the server says so in its log. |
| `towerRuns.max` | 4 | The most pi runs at once. |
| `towerRuns.headless` | `false` | Every tower run is a `pi --mode rpc` child of the sb server, with no pane; a tower's tab is a viewer typed into once. Off is 0.84.0's behavior. See [Headless runs](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/#headless-runs). |
| `towerRuns.pi` | none | pi's CLI file for headless runs, when the `pi` on the server's `PATH` is not the one. |
| `integration` | `on` (`off` under `STRAW_BOSS_DESK=1`) | `off` turns the [merge train](/pi-straw-boss/docs/guide/merge-train/) off on this computer. On is `on`, `true`, `1`, or `yes`; off is `off`, `false`, `0`, or `no`. Any other value, and a file that cannot be read, turns it off with a notice. |
| `locale` | from the environment | sb's language, `zh-TW` or `en`: the stand-in, the head's label, the tower prompt, a run's cards, and the `/boss` commands. Without it `LC_ALL`, `LC_MESSAGES`, or `LANG` decides, else the system's language. `/boss locale` sets it. See [Language](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/#language). |
| `stallWatch.enabled` | `true` | The [stall watch](/pi-straw-boss/docs/guide/process-hygiene/#the-stall-watch): the sb server tells a workspace's tower when a pi session looks frozen. It never stops the session. `false` turns it off. Every `stallWatch` key is read once a minute, so a change needs no restart. |
| `stallWatch.cpuPercent` | 75 | How much of one core counts as pegged, from 10 to 100, as the average over `cpuMinutes`. A minute under half of it is calm and starts the count again. A healthy session with a long history can pass this for a minute while it works (two were measured at 73 and 83); what sets it apart is that it writes its session file, so a lower value buys little and risks false reports. |
| `stallWatch.cpuMinutes` | 5 | Minutes in a row, none of them calm, over which a pi must average `cpuPercent` or more, with its session file not written, before it is told. One minute a little under the threshold does not start the count again. `0` turns this signal off. |
| `stallWatch.silentMinutes` | 30 | Minutes in a row a pane may say working with its session file not written and no tool call open. A session that answers and opens a tool call has recovered. `0` turns this signal off. |
| `stallWatch.missingMinutes` | 3 | Minutes in a row a live pi may be absent from pi-intercom's list; also the grace after a server restart. `0` turns this signal off. |
| `stallWatch.remindMinutes` | 60 | How long after an incident was told the first reminder comes; each later one waits twice as long, up to 8 hours. A reminder waits while the signals are gone. `0` sends no reminder. |
| `capacity.budget` | none | This device's capacity in points (over 0, at most 1000), for [device capacity](/pi-straw-boss/docs/reference/how-it-works/how-it-works/#device-capacity) on the work board: the sb server compares the points its mains' running work uses (a todo's `metadata.points`) and their smallest ready todo with it, and tells the tower when room stays free for 10 minutes. Unset, the numbers still show and nothing is flagged as idle capacity. Read once a minute. On an unattended device it also gates `worker` subagents by points, read at each launch so a change applies at once; unset, nothing is held back. On an attended device no worker is ever held back. |
| `link.relay` | none | The relay a new [Straw Link](/pi-straw-boss/docs/guide/straw-link/) team uses by default. |
| `link.trust` | `reply` for every device | How far this computer trusts each teammate's device: `reply`, `forward`, or `dispatch`. |
| `subagentNudge.idleMinutes` | 10 | How long a child of [sb's subagent host](/pi-straw-boss/docs/reference/how-it-works/the-subagent-host/) may sit idle, its turn ended and no result delivered, before sb asks it to finish, through the child's own pi and never into unsent text in its input box. Interactive children and persistent specialists are never asked. Fractions are allowed; `0` turns the nudge off. Read at most every 15 seconds. |
| `subagentNudge.max` | 2 | How many times one run is asked, from 1 to 10, one per idle stretch. When it is still idle that long after the last one, its parent is told once and sb stops asking. |

The page and the `/boss link` commands write the `link` section's `teams` themselves; edit it by hand only to fix it.
On an unattended device, the root-owned `/etc/straw-link/policy.json` takes the teams and the trust instead, and the `link` section is ignored.

## The project's `apps.json`

A project describes its apps in `.straw-boss/apps.json` at the git root (or `.claude/straw-boss/apps.json` when the first is absent).
A main reads it when it splits work by app, and a merge train reads its `integration` fields.
Without the file, a repository holding one codebase is its own single app.

```json
{
  "integration": { "skill": "integrate", "maxCars": 4, "maxWaitMin": 60 },
  "apps": [
    {
      "name": "api",
      "dir": "apps/api",
      "match": ["backend", "rest api"],
      "integration": { "base": "develop", "stages": ["merge", "deploy"], "accept": ["e2e"], "targets": { "test-env": "auto" } }
    }
  ]
}
```

[`prompts/apps-config.md`](https://github.com/wayne930242/pi-straw-boss/blob/main/prompts/apps-config.md) describes every field.

## Environment variables

Set these in the environment of `herdr server` and the sessions it starts.

| Variable | What it does |
| --- | --- |
| `PI_CODING_AGENT_DIR` | pi's agent folder, where the state folder `straw-boss/` lives. Default `~/.pi/agent`. |
| `STRAW_BOSS_INTEGRATION` | `off` or `on`: the merge train switch. A non-empty value wins over `integration` in `config.json`. |
| `STRAW_BOSS_DESK` | `1` for a desktop shell that shows the page itself: the GUI opens no browser, and the merge train is off unless you set it on. See [Desk mode](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/#desk-mode-up---dir). |
| `STRAW_BOSS_ASCII` | `1` draws the tower's standing pane with ASCII only. `NO_COLOR` and `TERM=dumb` drop its colours. |

## Other files

- **Music for Zen:** audio files in `~/.pi/agent/straw-boss-music/`. See [The browser view](/pi-straw-boss/docs/guide/browser-view/#zen).
- **What the extension writes:** see [What it writes](/pi-straw-boss/docs/reference/how-it-works/what-it-writes/).
