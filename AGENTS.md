# Agent notes

`README.md` describes the extension, `docs/how-it-works.md` its behavior, and `docs/specs/` the design records. Run `npm run check` and `npm test` before handing over a change.

## Docs

- `README.md` and `README.zh-TW.md` stay short: the pitch, install, quick start, and the common commands. Every tool and `/boss` command goes in `site/src/content/docs/reference/commands.md` and its twin under `site/src/content/docs/zh-tw/`; a user-facing feature gets its guide page there in both languages.
- `site/` is the Starlight documentation site, served at https://wayne930242.github.io/pi-straw-boss/docs/ under the GUI demo by `.github/workflows/pages.yml`. `site/scripts/sync.mjs` generates its how-it-works, unattended-device, and release pages from `docs/`, so `docs/` stays the one source; keep `docs/how-it-works.md` anchors stable, since `src/` and the release notes link to them. `cd site && npm ci && npm run build` validates every internal link and anchor.
- `docs/how-it-works.zh-TW.md` mirrors `docs/how-it-works.md` line for line, and its first line names the English commit it matches. A change to the English file changes the same lines of the twin and moves that commit, or leaves the drift for a batch pass; `npm --prefix site run check` lists the English commits not yet translated and fails when the headings no longer match; `npm test` (tests/twin.test.ts) fails on the same line-for-line, heading, and bold checks before a push.

## Tests

- `npm test` runs the suite and `npm run test:one -- tests/x.test.ts` one file (not a bare `node --test`): both load `tests/setup.ts` first, which gives each test process (a test file runs in its own) a temp root of its own for HOME, USERPROFILE, and the agent folder, drops the Herdr pane, intercom identity, and subagent role of the shell it runs from, and points `HERDR_SOCKET_PATH` at a path nobody listens on. Without it a session's look in a test could start a real detached sb server in `~/.pi/agent/straw-boss` and leave it running. A refusal of that guard inside a test process fails the process when it ends, unless the test that asserts it on purpose takes the record (`consumeRefusals()` in `src/server/testguard.ts`); give a session the world's `sw.ctx()` (`sw.server()`) instead of letting it be refused. The run also fails when an entry is new at the top of the checkout (or of the folder it ran in) after it, or when a `~` is there at all: `npm test` or `pretest` run by a shell whose HOME is empty or `~` writes npm's cache and logs to a literal `./~/.npm`, which the tests cannot prevent but flag (`strays` in `tests/isolation.ts`); fix HOME and remove the folder.
- A session of a test gets the fake spawn of `tests/server-world.ts` (`sw.ctx()`). `src/server/testguard.ts` refuses the real detached start in a test run unless `SB_TEST_REAL_SERVER=1` is set, and refuses any start whose working folder or state folder (the session's env, HOME or PI_CODING_AGENT_DIR) is outside the root. What it lets through is noted by pid; at the end of each test process the leftovers are killed and the process fails.
- A test world that starts sessions with looks (`server-world.ts`) passes `sw.server(...)` as the session's `server` deps, so `close()` waits for the looks in flight before it removes the folder.
- A test does not bound a wait by the bare wall clock (`Date.now() - began < 1500`) or sleep to let a timer pass: at a load average of 100 the process stands still for seconds. It moves a clock it owns (`tests/fake-clock.ts`, `TowerWorld.runClock`), ends the wait itself (`held()` in `handover-live.test.ts`), or, for real I/O, allows the stall it measured (`stallWatch`). A child process that must exit on its own arms an unref'd `process.exit(3)` timer where its loop should drain, after anything it awaits.

## Bumping pi

- `@earendil-works/pi-coding-agent` is pinned in `devDependencies`. After a bump, the run-tools parity test (`tests/run-tools.test.ts`, "the guard's resolver agrees with pi's own") must pass: `resolveArg` in `src/link/allow.ts` mirrors pi's `resolveToCwd`, and the test compares it with the installed copy only, so a pi that changes its path rules is caught here and nowhere else. A user's global pi may be newer than the pin; check its `utils/paths.js` and `core/tools/path-utils.js` against the pinned copy too.

## Live checks

- Run a live demo in scratch workspaces of the default Herdr, not in a headless named session (`herdr --session X server`): pi-intercom's broker resolves `herdrLocation` only against the default Herdr, so sessions joined there never appear. Move the scratch workspaces first with `workspace.move` over the socket API so the head tower is theirs.
- A process started from a pi session's shell inherits `PI_SUBAGENT_ID` and `PI_INTERCOM_SESSION_ID`. A Herdr server started that way makes every pane's pi act as a subagent, and the extension stays silently inactive. Start such servers with `env -i`.
- pi overwrites its process title, so `pgrep -f` cannot find it by arguments. Take PIDs from `herdr pane process-info --pane <id>`.
- Safety Net blocks `rm -r` outside the cwd and `find -delete`: remove scratch session files one by one with `rm`, then the directories with `rmdir`.

## Design

- Reading the screen cannot tell a TUI dialog's state apart from model-written text. Review rounds broke such a check with transcript text, model text inside the dialog box, ANSI escapes in model text (`\x1b[3G`, split SGR), and a hidden draft restored by the dialog. Anything that sends keys to a dialog needs a state signal from the extension that owns the dialog, or a re-read after every key step.
- Whether the server may type the tower prompt's command into a standing pane (F10: never into a pane that runs a program) is decided by `src/server/typegate.ts` alone. A fix for a pane typed into wrongly changes a rule there and its table test (`tests/typegate.test.ts`), never a branch in `standing.ts` or `runs.ts`, which only gather facts and act on the answer (the marks set at `attach` and `reset` are facts, listed in the header of `typegate.ts`); B6 review rounds RV10 to RV14 reopened F10 three times because each fix touched one path.
