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
  "stallWatch": { "cpuMinutes": 5, "silentMinutes": 30 },
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
| `integration` | `on` (`off` under `STRAW_BOSS_DESK=1`) | `off` turns the [merge train](/pi-straw-boss/docs/guide/merge-train/) off on this computer. On is `on`, `true`, `1`, or `yes`; off is `off`, `false`, `0`, or `no`. Any other value, and a file that cannot be read, turns it off with a notice. |
| `stallWatch.enabled` | `true` | The [stall watch](/pi-straw-boss/docs/guide/process-hygiene/#the-stall-watch): the sb server tells a workspace's tower when a pi session looks frozen. It never stops the session. `false` turns it off. Every `stallWatch` key is read once a minute, so a change needs no restart. |
| `stallWatch.cpuPercent` | 75 | How much of one core counts as pegged, from 10 to 100, as the average over `cpuMinutes`. A minute under half of it is calm and starts the count again. A healthy session with a long history can pass this for a minute while it works (two were measured at 73 and 83); what sets it apart is that it writes its session file, so a lower value buys little and risks false reports. |
| `stallWatch.cpuMinutes` | 5 | Minutes in a row, none of them calm, over which a pi must average `cpuPercent` or more, with its session file not written, before it is told. One minute a little under the threshold does not start the count again. `0` turns this signal off. |
| `stallWatch.silentMinutes` | 30 | Minutes in a row a pane may say working with its session file not written and no tool call open. A session that answers and opens a tool call has recovered. `0` turns this signal off. |
| `stallWatch.missingMinutes` | 3 | Minutes in a row a live pi may be absent from pi-intercom's list; also the grace after a server restart. `0` turns this signal off. |
| `stallWatch.remindMinutes` | 60 | How long after an incident was told the first reminder comes; each later one waits twice as long, up to 8 hours. A reminder waits while the signals are gone. `0` sends no reminder. |
| `link.relay` | none | The relay a new [Straw Link](/pi-straw-boss/docs/guide/straw-link/) team uses by default. |
| `link.trust` | `reply` for every device | How far this computer trusts each teammate's device: `reply`, `forward`, or `dispatch`. |

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
