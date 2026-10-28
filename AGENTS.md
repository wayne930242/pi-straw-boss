# Agent notes

`README.md` describes the extension, `docs/how-it-works.md` its behavior, and `docs/specs/` the design records. Run `npm run check` and `npm test` before handing over a change.

## Tests

- `npm test` runs the suite and `npm run test:one -- tests/x.test.ts` one file (not a bare `node --test`): both load `tests/setup.ts` first, which gives each test process (a test file runs in its own) a temp root of its own for HOME, USERPROFILE, and the agent folder, drops the Herdr pane, intercom identity, and subagent role of the shell it runs from, and points `HERDR_SOCKET_PATH` at a path nobody listens on. Without it a session's look in a test could start a real detached sb server in `~/.pi/agent/straw-boss` and leave it running. A refusal of that guard inside a test process fails the process when it ends, unless the test that asserts it on purpose takes the record (`consumeRefusals()` in `src/server/testguard.ts`); give a session the world's `sw.ctx()` (`sw.server()`) instead of letting it be refused.
- A session of a test gets the fake spawn of `tests/server-world.ts` (`sw.ctx()`). `src/server/testguard.ts` refuses the real detached start in a test run unless `SB_TEST_REAL_SERVER=1` is set, and refuses any start whose working folder or state folder (the session's env, HOME or PI_CODING_AGENT_DIR) is outside the root. What it lets through is noted by pid; at the end of each test process the leftovers are killed and the process fails.
- A test world that starts sessions with looks (`server-world.ts`) passes `sw.server(...)` as the session's `server` deps, so `close()` waits for the looks in flight before it removes the folder.
- A test does not assert a wall-clock bound on a wait (`< 1500` ms), and does not sleep a time to let a timer pass: at a load average of 100 the process stands still for seconds. A wait reads off a clock the test moves (`tests/fake-clock.ts`; `TowerWorld.runClock` for the ages the tower runs' watcher sees), a start-time read the test ends (`held()` in `handover-live.test.ts`), or, for a bound on real I/O, the stall the process measured (`stallWatch`). A child process that must exit on its own watches itself (an unref'd `process.exit(3)` timer in its script) instead of being timed from outside.

## Live checks

- Run a live demo in scratch workspaces of the default Herdr, not in a headless named session (`herdr --session X server`): pi-intercom's broker resolves `herdrLocation` only against the default Herdr, so sessions joined there never appear. Move the scratch workspaces first with `workspace.move` over the socket API so the head tower is theirs.
- A process started from a pi session's shell inherits `PI_SUBAGENT_ID` and `PI_INTERCOM_SESSION_ID`. A Herdr server started that way makes every pane's pi act as a subagent, and the extension stays silently inactive. Start such servers with `env -i`.
- pi overwrites its process title, so `pgrep -f` cannot find it by arguments. Take PIDs from `herdr pane process-info --pane <id>`.
- Safety Net blocks `rm -r` outside the cwd and `find -delete`: remove scratch session files one by one with `rm`, then the directories with `rmdir`.

## Design

- Reading the screen cannot tell a TUI dialog's state apart from model-written text. Review rounds broke such a check with transcript text, model text inside the dialog box, ANSI escapes in model text (`\x1b[3G`, split SGR), and a hidden draft restored by the dialog. Anything that sends keys to a dialog needs a state signal from the extension that owns the dialog, or a re-read after every key step.
