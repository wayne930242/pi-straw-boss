# Verification: stash and pop

| Requirement | Evidence | Result |
|---|---|---|
| Stash refuses a busy shell, closing nothing | Live: `sleep 600` in the scratch base's shell, `/boss stash live1` in its main → "Nothing was stashed: pane wR3:p4 runs sleep."; the base stayed open | pass |
| Stash refuses a running turn, a subagent, a session's own reasons, a silent session, a sub workspace or a busy one under it, a taken or bad name | `tests/stash.test.ts` (refusal tests), `tests/bridge.test.ts` (stash-check reasons), `tests/dialogs.test.ts` (hub request) | pass |
| Every session of the net answers the check through the GUI server, started in the background when none ran | Live: the second `/boss stash` refused only the shell; no "did not answer" for the tower, main, or member | pass |
| The manifest records label, folder, tower tab first, each pane's role, session file, name, folder | Live: `stash/live1.json` held the tower tab, then `work` with main, member, shell, each with its session file | pass |
| The base closes after the manifest is written | Live: no `sbstash-live` workspace after the stash | pass |
| A half-stopped close keeps nothing stashed and names each `pi --session` file | `tests/stash.test.ts` | pass |
| `/boss pop` from another workspace reopens the same tabs and labels, tower first, main before member, each in its role | Live: `/boss pop live1` from `sbstash-ctl` → "Popped "live1": 3 sessions are back in sbstash-live"; tower token live, roles tower/main/member, same session files, shell reopened | pass |
| Each pi resumes its conversation | Live: each resumed pane shows its marker word (PAPAYA, QUOKKA, ZEPHYR) from before the stash; new entries append to the same file | pass |
| On success the manifest moves to `stash/popped/` | Live: `popped/live1-2026-10-22T09-57-56-695Z.json` | pass |
| A failed pop closes the new workspace and keeps the manifest; a missing session file opens nothing | `tests/stash.test.ts` | pass |
| Popped panes run under the popping session's `PI_CODING_AGENT_DIR` | `tests/stash.test.ts`; live (the scratch agent dir loaded only this checkout) | pass |
| An older bridge is never closed by a check | By construction: a new message type an older bridge ignores; counted as no answer (`tests/stash.test.ts`) | pass |

`npm run check` clean; `npm test` 721 of 722 pass, 0 fail.

## Deviations from the approved spec

- Names: any file-safe name (no slash, backslash, control character, or leading dot, at most 64), not `[A-Za-z0-9._ -]`, because workspace
  labels are often Chinese. The spec was updated.
- A close that stops half way deletes the manifest instead of keeping it: popping it would run a session file that is still in use. The notice
  gives each session's `pi --session` file. The spec was updated.
- Pop passes the popping session's `PI_CODING_AGENT_DIR` to every pane it opens (not in the spec): a session run under a custom agent dir
  resumes under it. Found while setting up the live check.

## Live check setup

A scratch agent dir loading only the Herdr state extension, pi-intercom, and this checkout; a scratch base in the default Herdr (tower, main, member, shell)
with hand-made session files named `<time>_<session id>.jsonl` (the scratch dir had no model login). The net binds a bridge only when the file name
carries its session id, so files named otherwise counted as silent: real pi session files are always named this way.

## Review (fresh-context reviewer, claude-opus-5-5)

No P0 or P1. All fixed in this change set:

| Finding | Fix | Evidence |
|---|---|---|
| F001 P2: a turn started between check and close was quit | A stash's close carries `ifStashable`; the bridge runs its check inside the close and refuses; Herdr's side is surveyed again before the manifest | `tests/bridge.test.ts`, `tests/stash.test.ts` (closer path, shell job started meanwhile) |
| F002 P2: a shell with no folder wrote a manifest pop could not read | Refused in the survey; the manifest is checked with pop's own rule before anything closes | `tests/stash.test.ts` |
| F003 P2: two sessions could pop one stash | The pop claims the manifest by renaming it into `stash/.popping/`; it goes back on failure | `tests/stash.test.ts` |
| F004 P3: an older server's 404 showed raw | Matched on `error: not_found` | read |
| F005 P3: spec said 5 s | Spec states the three rounds | spec |
| F006 P3: shells in sub workspaces were not checked | Checked with the same foreground rule | `tests/stash.test.ts` |

After the fixes: `npm run check` clean; `npm test` 726 pass, 1 skipped, 0 fail. The live check above ran before these fixes; they change the
check and the claim, not the start order, and were not run live again.
