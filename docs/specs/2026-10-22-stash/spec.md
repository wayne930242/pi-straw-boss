Status: approved
Approved at: 2026-10-22
Approved from: 「照規格實作（建議）」

# Stash and pop a base

`/boss stash [name]` puts a whole base (one workspace: its tower, its mains, its members, and its idle shells) away: every agent quits
cleanly, the workspace closes, and a manifest remembers what ran where. `/boss pop [name]` opens it again: the same tabs, each pi resumed
from its own session file (`pi --session <file>`), in the order that gives every one its old role back.

A tower is one per workspace, so "a tower and everything under it" is the workspace. Version 1 refuses rather than loses work: anything
that a resume cannot bring back makes the stash fail and names who is in the way.

## Observable behavior

### `/boss stash [name]`

Run from any session of the net (tower, main, or member) in the base to stash. `name` defaults to the workspace label; it is
at most 64 characters with no slash, backslash, or control character, does not start with a dot, and must not name an existing stash.

1. **Check, nothing closes yet.** The stash is refused, with every reason listed, when any of these holds:
   - the workspace is a sub workspace (a linked worktree);
   - a pi pane's Herdr status is not `idle` or `done` (a turn is running, or it waits on a dialog);
   - a pi pane is a subagent (pi with no `sb_role` of tower, main, or member), in this workspace or in one of its sub workspaces;
   - a shell pane runs something in its foreground other than the shell;
   - a session of the net answers the stash check with a reason: its own turn is not idle, messages wait in its queue, a dialog is open,
     or a background monitor is running;
   - a session of the net does not answer the check in three rounds (1 s each, 2 s apart, the net read again before each; an older
     pi-straw-boss, or a stuck one);
   - a pi pane has no session file Herdr knows of, or a pane has no folder Herdr knows of;
   - a sub workspace of the base runs an agent, or a shell there runs something.
   Herdr's side is checked once more after the sessions answered, since the rounds take seconds.
2. **Manifest.** `<state dir>/stash/<name>.json` records the workspace label and folder, then each tab in Herdr's order with its label
   and panes: for a pi pane its role, session file, session name, and folder; for a shell its folder.
3. **Close.** Every agent quits as `/boss close` would (its shutdown clears its tokens), then the workspace closes with its shells. A
   stash's close carries the check: a session that stopped being stashable since it answered (a turn started) refuses to quit. This
   is the GUI's close-base batch: a session that refuses here, or is still running after 30 s, stops it; the workspace then stays open
   and the manifest is deleted, because popping it would run a session file that is still in use a second time; the notice gives each
   session's `pi --session <file>` so the ones that did quit can be resumed by hand.
4. The stash runs in the session that holds the GUI server. When none runs, `/boss stash` starts it in the background (no browser opens).
   When the server's session is itself in the stashed base, it is closed last, with the workspace.

### `/boss pop [name]`

Run from any session in Herdr. With no name and one stash, that one; with several, a picker. Tab completes the stash names.

1. A new workspace opens in the recorded folder, labelled as before.
2. The tower first, when there was one: its tab is the first, labelled with the tower glyph; its pi resumes and takes the role back from
   its own session (it marked itself a tower there). Pop waits until the workspace's tower token names a live session (60 s).
3. Then each tab in order: the main resumes first and pop waits until it joined as `main`; then each member, split into the same tab,
   waits until it joined as `member`; then each shell opens in its folder.
4. Done: the manifest moves to `<state dir>/stash/popped/` and the notice says how many sessions came back. A pop claims the
   manifest first by moving it into `stash/.popping/`, so a second pop of the same stash, from any session, opens nothing.
5. Failure (a pi did not start or did not join in time): the new workspace closes, the manifest goes back, and the notice says which
   pane failed. Popping again starts over.

### Edge cases

- A session file that no longer exists at pop: pop refuses before opening anything, naming the file.
- A popped workspace's id differs from the stashed one; nothing depends on the old id (the tower's agent name carries the new one).
- Intercom asks that were pending between sessions are not carried over; the check above means none was in flight from the stashed side
  (no session was mid-turn), but an ask from another workspace to a stashed session fails as for any closed session.
- `/boss stash` from a subagent: refused (a subagent has no `/boss` session of its own in the net).

## Compatibility

- New bridge message `stash-check` / `stash-check-result`. A bridge from an older version ignores it, so it counts as no answer and the
  stash is refused; nothing older is ever asked to quit by a check.
- The close-base batch (`closer.ts`) keeps its contract; stash reuses it after its own check.
- No change to the GUI page in version 1.

## Non-goals (version 1)

- Stashing running subagents and re-attaching them to their parent (needs a pi-herdr-agents API).
- Restarting background monitors; carrying over pending intercom asks.
- Pane geometry: members are split back into their tab, not at their old size or direction.
- GUI buttons for stash and pop.

## Standards

- `AGENTS.md`: `npm run check` and `npm test` before handing over; a live check in scratch workspaces of the default Herdr.
- `~/.pi/agent/rules/typescript.md`: interfaces for object shapes, no `any`, named exports.

## Reality anchor

- Unit: `tests/stash.test.ts` with the fakes in `tests/fakes.ts` (Herdr listings, sessions, bridge answers): each refusal reason, the
  manifest, the order of starts at pop, and the cleanup after a failed pop.
- Live checkpoint: in a scratch workspace with a tower, a main, a member, and a shell, `/boss stash` then `/boss pop`; each pi comes back
  with its role and its conversation (it can recall the last thing said before the stash).
