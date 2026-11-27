# Spike 0a: a packed pi-straw-boss as the Maestro host

Slice 0a of the host switch (plan: `weihung-agent-root/scratch/sb-maestro/host-switch.md`, §6). Branch `spike/maestro-host` from `origin/main` 6a23f9c6. Run 2026-11-27, 13:20–13:45Z.

**Result: pass on both platforms, with a scripted model.** A packed sb, served from a throwaway npm registry and installed with `pi install npm:pi-straw-boss@<prerelease>` in a credential-free environment with an empty npm cache, registers the Maestro tools from its own entry. A real parent pi launched one real child pi in a Herdr split pane through it and received the child's result as a new message. The loaded run owner answered `pi-herdr-agents:runs:v1` with the live child.

The model on both sides was `scripted-model.mjs`, a local OpenAI-compatible endpoint, because no provider was reachable without copying credentials (the Gemini key in the environment returned 402, prepaid credits depleted). The caller approved this. A real provider in the child is **not** proven here; it is deferred to slice 1.

## What the spike adds

| Path | What |
|---|---|
| `package.json` | dependency `@nubl/maestro` = `git+https://github.com/wayne930242/maestro.git#201a0f9467b43cbeb47d48c500efb1358d40a19d` (fork `weihung-integration`, committed `dist/`); `./src/host/index.ts` in `pi.extensions`; `config.json.example` in `files` |
| `src/host/index.ts` | Lazy entry. It imports no Maestro module until the host is selected: `PI_STRAW_BOSS_HOST`, then `<agentDir>/straw-boss/host.json`, then `~/.pi/agent/straw-boss/host.json`, else **on** (the boss: 「我其實希望 npm 就把派工裝起來」) |
| `src/host/engine.ts` | `createPiExtension({ hostSurface, presentation, childEntryPath, configAssetRoot })`, adapted from pi-herdr-agents `index.ts`, with the same load stamp |
| `src/host/child.ts` | The child entry every launch passes with `-e` (`createChildExtension(renderChildWidget)` plus the protocol exports) |
| `src/host/{host-surface,marker-transport,widgets,renderers,tool-renderers,child-widget,engine-build,load-stamp}.ts`, `src/host/herdr/*.ts` | Copied from pi-herdr-agents `f1590cb` with a one-line source header; only the import paths of `host-surface.ts` and `marker-transport.ts` changed (4,721 lines in all; 91 of them new) |
| `NOTICE.md`, `config.json.example` | Giuseppe Rodriguez's full MIT notice and the source SHA; the config example Maestro reads at load |
| `tests/imports.test.ts` | The manifest test now expects `config.json.example` and the Maestro dependency |
| `spike/host-0a/` | This harness: `Dockerfile.linux`, `verdaccio.yaml`, `install.sh`, `drive.sh`, `probe.ts`, `scripted-model.mjs` |

Checks run on this tree: `npm run check` (pass); `npm run test:one -- tests/imports.test.ts` (10/10); `tests/doctor-cli`, `hygiene`, `rolepack`, `server-build`, `train-contract` (57/57). The full `npm test` did not run: this is a spike, and slice 1 runs the full suite.

## How it was proven

1. **Registry.** verdaccio 6.11.3 ran in a `node:24` container (`sbspike-registry`, uplink npmjs) and served `pi-straw-boss@0.110.0-spike.1` (tag `spike`; `latest` stayed 0.109.1 from the uplink). The version was set for the pack only; `package.json` keeps 0.109.1.
2. **Linux.** The image is `ubuntu:24.04` with NodeSource `nodejs=24.*` (24.22.3) installed as box 2 does it, and herdr 0.9.5 `linux-aarch64` checked against box 2's sha256. `npm i -g @earendil-works/pi-coding-agent@1.6.1` was installed under the `prefix=~/.local` `.npmrc`, as user `agent`. The environment had no `~/.ssh`, no ssh agent, no git credential helper, `GIT_TERMINAL_PROMPT=0` and no `~/.npm`. A fresh container ran `install.sh`, then the scripted model and a headless `herdr --session spike0a server`, then `drive.sh`.
3. **Mac.** Everything ran under `env -i`: `HOME=/tmp/sb0a` (a symlink into `.scratch/`, so Herdr's socket path stays under the macOS limit), `PI_CODING_AGENT_DIR=/tmp/sb0a/agent`, `npm_config_cache` set to a scratch folder, global and user npmrc off, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` and a batch-mode ssh. The pi was nvm Node 24.22.1 with pi 1.6.1. Herdr was a separate headless session server (`herdr --session sb0a server`, socket `/tmp/sb0a/.config/herdr/sessions/sb0a/herdr.sock`) that never touched the boss's Herdr. `drive.sh` opened a workspace there and closed it at the end.

`drive.sh` types one command into the workspace's root pane: `pi -e probe.ts --model spike/scripted 'SPIKE-PARENT-GO: …'`. It then waits on the parent's session file, not on a CLI. The probe is evidence only: it reads `getAllTools()` `sourceInfo`, the `pi-herdr-agents/load-stamp` global, and `pi-herdr-agents:runs:v1`.

## Evidence

### Install resolution (identical on both)

- Pi ran `npm install pi-straw-boss@0.110.0-spike.1 --prefix <agentDir>/npm --legacy-peer-deps --no-audit --no-fund`, in 8 s (Linux) and 9 s (Mac).
- Maestro was fetched as `GET https://codeload.github.com/wayne930242/maestro/tar.gz/201a0f9467b43cbeb47d48c500efb1358d40a19d 200`; no git or ssh process ran.
- npm then **prepared the git dependency**. It ran `npm install --force --include dev --include peer …` twice in `_cacache/tmp/git-clone*`, which pulled Maestro's devDependencies.
- Hidden lock, `npm/node_modules/.package-lock.json`, entry `node_modules/@nubl/maestro`:
  - `resolved: git+ssh://git@github.com/wayne930242/maestro.git#201a0f9467b43cbeb47d48c500efb1358d40a19d`
  - `integrity: sha512-lIki3/bm/DCnBMoyzvA4yMgmRUTEpv/3O0pLRP00sSKHBTQKsZCqWXtyk/Pvf/f5EX8qDsJcQE9+urGKhyUizg==`
  - npm warns `skipping integrity check for git dependency`.
- Entry `node_modules/pi-straw-boss`: `resolved: http://<registry>/pi-straw-boss/-/pi-straw-boss-0.110.0-spike.1.tgz`.
- Maestro realpath: `<agentDir>/npm/node_modules/@nubl/maestro`, flat, with no nested copy. Its `dist/` holds 406 files with digest `dfae1fb1…0da0ec1`, the same as the committed `dist/` of 201a0f9 (sha256 over `sha256sum` lines).
- **Peer sources:** nothing under `npm/node_modules` provides `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, `@sinclair/typebox` or `typebox`. Both `pi` binaries are Pi 1.6.1's `dist/bundle/cli.js`, the bundled Node build, so jiti runs every extension module with Pi's embedded virtual modules (`tryNative: false`), Maestro's compiled `dist/` included. Its runtime imports (`getAgentDir`, `SessionManager`, `Type`, …) resolve there.
- An upgrade that keeps the pin works with the lock present: `pi install npm:pi-straw-boss@0.110.0-spike.2` printed `changed 1 package in 1s` and fetched nothing from GitHub. `pi update` skips extensions unless `--extensions` is given.

### Load (probe `start` record, Linux; the Mac matches, with its own paths)

```json
{"tools": [10 tools: subagent, subagent_resume, subagent_send, subagent_stop, subagent_interrupt, subagent_cancel, subagents_list, subagents_write_task_models, worktree_list, worktree_remove],
 "source": "npm:pi-straw-boss@0.110.0-spike.1", "path": "/home/agent/.pi/agent/npm/node_modules/pi-straw-boss/src/host/index.ts",
 "stamp": {"wrapperVersion": "0.110.0-spike.1", "wrapperRoot": "/home/agent/.pi/agent/npm/node_modules/pi-straw-boss",
   "maestroSpec": "git+https://github.com/wayne930242/maestro.git#201a0f9467b43cbeb47d48c500efb1358d40a19d",
   "maestroVersion": "0.1.2", "maestroRoot": "/home/agent/.pi/agent/npm/node_modules/@nubl/maestro", "generation": 1},
 "runs": {"version": 1, "runs": []}}
```

### Round trip

| Step | Linux (13:32:05Z) | Mac (13:37:38Z) |
|---|---|---|
| Parent turn 1 calls `subagent {name: spike-child}`; result `status: started` | id `2aa206f3…` | id `c96df910…` |
| `runs:v1` while the child lives | `[{id: 2aa206f3…, name: spike-child, persistent: false, delivery: pending}]` at +0.5 s | `[{id: c96df910…, …, delivery: pending}]` |
| Launch script | `# Surface: w1:p2` (legacy Herdr split), `pi --session … -e …/pi-straw-boss/src/host/child.ts --model spike/scripted` | `# Surface: w2:p2`, `-e …/pi-straw-boss/src/host/child.ts` |
| Child request (scripted model log) | tools include `caller_ping` (child protocol from sb's `child.ts`) and `subagent`; answers `SPIKE-CHILD-RESULT-7f3a` | same |
| Delivered to parent | `custom_message` `subagent_result`: `Sub-agent "spike-child" completed (0s)` … `<subagent_report from="spike-child" kind="result">SPIKE-CHILD-RESULT-7f3a</subagent_report>`, then `Model used: spike/scripted` | same, `completed (1s)` |
| Parent's next turn | `SPIKE-PARENT-RECEIVED SPIKE-CHILD-RESULT-7f3a` | same |
| `runs:v1` after delivery | `[]` | `[]` |
| Outcome ledger `herdr-agents/outcomes.jsonl` | `outcome: completed, verdict: none, model: spike/scripted` | same |
| Child pane | closed by Maestro, and the parent workspace was closed by `drive.sh` | same; `pane list` was empty afterwards, and no pi was left under the sb0a server |

### Failures on the way

- **`0.110.0-spike.0` did not load:** `Failed to load extension "…/pi-straw-boss/src/host/index.ts": Missing subagent status config. Expected <agentDir>/herdr-agents/config.json or …/pi-straw-boss/config.json.example`. The tarball lacked `config.json.example`. Fixed in spike.1 (`files`), and the manifest test now pins it.
- **The first Mac drive stopped at Pi's project-trust dialog:** the work folder was inside this checkout, whose `AGENTS.md` makes it a project. The second run used `/tmp/sb0a-work`. This has nothing to do with the host.
- **sb itself warns in both runs:** `Straw Boss: the sb server could not start: intercom: pi-intercom (>= 0.17.1) was not found`. A plain `pi install npm:pi-straw-boss` brings no pi-intercom, so sb's own server does not start. The Maestro host works without it.

## What the real host needs beyond the spike (feeds slice 1)

1. **Double-host check before any default-on release (F015).** The spike's host is on by default and has no conflict check. With pi-herdr-agents also loaded, both would register `subagent` and share the `pi-herdr-agents/load-stamp`, `engine-build` and `pi-subagents/runtime` slots, and the last loader would win. Slice 1 must stand down or refuse loudly from pre-dedupe registration evidence.
2. **`npm pack --dry-run` test** listing `config.json.example`, `NOTICE.md` and `src/host/child.ts`, plus a load test that the host starts from the packed file set: the spike.0 failure would have shipped otherwise. The operating skill (`skills/`) is still to be copied.
3. **pi-intercom for a plain npm install.** "npm installs dispatch" holds for the Maestro tools, but sb's server needs pi-intercom, which the install does not bring. Either sb declares it, or the install docs and `sb_doctor` say so. This is the boss's call, because it changes what a plain install pulls in.
4. **Child entry path stability:** `-e <agentDir>/npm/node_modules/pi-straw-boss/src/host/child.ts`. Keep this file at this path in every release (plan §3, child entries).
5. **Run-rows port, `sb_doctor` host states, freeze, drain-check, revive readiness:** none are in the spike.
6. **Core path:** only the legacy Herdr surface (split pane) ran. Core (`herdr.backend: core`) is untested.
7. **`maestroBuildInfo()` gives version and root only.** The SHA comes from the hidden lock's `resolved` (it is what `engine-build.ts` keys on). `sb_doctor` should read the same entry.

## Risks found

- **The git dependency is prepared on every fresh install (medium).** npm runs a full dev install of Maestro twice in a temp clone (pi-coding-agent ^1.5.2, typescript, biome, oxlint, …) before it packs the dependency. That costs time and network on each machine, and whatever Maestro's `prepack` would build replaces the committed `dist/`. Here the bytes matched the committed `dist/`. Keep `check:dist` green on every pinned SHA until slice 5 publishes Maestro to a registry, which removes this.
- **The lock records `git+ssh://` (low to medium).** npm writes the hosted-git ssh form into the hidden lock even though it fetched over https. Reinstalling with the same pin reused the installed copy, so nothing was fetched and nothing failed. Moving the pin to another SHA in a credential-free environment was not tried. It should resolve from the new `git+https` spec, but slice 1 or 3 should try it once on box 2's image.
- **Which pi runs the child on the Mac (medium).** The child's launch script runs a bare `pi` in a new pane's login shell. macOS `path_helper` puts `/usr/local/bin` (Homebrew Node 26, via `/usr/local/bin/node`) ahead of nvm unless the user's zsh startup puts nvm first again. The spike set that in the scratch `.zprofile`. A child can run on a different Node, or with another `pi`, than its parent. This is inherited from Maestro's launch script and pi-herdr-agents behaves the same; it is worth an issue upstream (use the parent's `process.execPath` and pi path).
- **Peers rest on Pi's bundled build (low).** A non-bundled Pi (source or dev runtime) resolves peers through jiti aliases or tsconfig paths instead, which was not tried. Maestro marks its peers optional, so npm never installs a second copy.
- **npm 11 `allowScripts` (low).** `esbuild`'s postinstall (tsx's dependency) is skipped with a warning. tsx still works through the optional platform package. Watch for this if sb ever relies on an install script.
- **A real provider in the child** is not proven (see above).

## Cleanup done

Both containers (`sbspike-registry`, `sbspike-linux`), the image `sbspike-linux`, the docker network `sbspike`, the two Mac monitors (scripted model on :4874, Herdr session `sb0a`) and their session folder, `/tmp/sb0a`, `/tmp/sb0a-work` and `.scratch/` were all removed. The boss's `~/.pi`, his Herdr, his running sessions and his `~/projects/maestro` checkout were not touched. One `git checkout` there was undone at once: HEAD is back on `weihung-integration` at 14009f0, with a clean tree.
