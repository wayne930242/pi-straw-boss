# Agent notes

`README.md` describes the extension, `docs/how-it-works.md` its behavior, and `docs/specs/` the design records. Run `npm run check` and `npm test` before handing over a change.

## Live checks

- Run a live demo in scratch workspaces of the default Herdr, not in a headless named session (`herdr --session X server`): pi-intercom's broker resolves `herdrLocation` only against the default Herdr, so sessions joined there never appear. Move the scratch workspaces first with `workspace.move` over the socket API so the head tower is theirs.
- A process started from a pi session's shell inherits `PI_SUBAGENT_ID` and `PI_INTERCOM_SESSION_ID`. A Herdr server started that way makes every pane's pi act as a subagent, and the extension stays silently inactive. Start such servers with `env -i`.
- pi overwrites its process title, so `pgrep -f` cannot find it by arguments. Take PIDs from `herdr pane process-info --pane <id>`.
- Safety Net blocks `rm -r` outside the cwd and `find -delete`: remove scratch session files one by one with `rm`, then the directories with `rmdir`.

## Design

- Reading the screen cannot tell a TUI dialog's state apart from model-written text. Review rounds broke such a check with transcript text, model text inside the dialog box, ANSI escapes in model text (`\x1b[3G`, split SGR), and a hidden draft restored by the dialog. Anything that sends keys to a dialog needs a state signal from the extension that owns the dialog, or a re-read after every key step.
