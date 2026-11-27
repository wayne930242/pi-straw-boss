# The quiet tower: a logbook instead of a wake

Status: built on `feat/tower-quiet`, not released. The behavior is in [how-it-works](../how-it-works.md#the-logbook).

## Decision

The boss, 2026-11-28: 「現在通知塔台的頻率是否太頻繁？我認為塔台似乎如今不需要這麼頻繁被通知，因為我們的記帳改善了，塔台只要有辦法查帳就好」. He chose:

- **milestone**: recorded in the workspace's logbook, with no wake. The one exception is a milestone that answers a tower request: a main the tower opened for a request reports done, and the tower relays it.
- **shared**: recorded as a heads-up (what, what it names, until when). Code compares it with the open heads-ups and the live work of its workspace, and across workspaces with the open heads-ups. The tower wakes only when two overlap; otherwise sb answers "recorded, no clash seen".
- **blocked**: wakes the tower, as before.

## Where the gate is

The sb server's intake for a tower identity (`src/server/towers.ts`, `wire`) asks `src/server/towergate.ts` before it queues a message. The gate reads only the header the sender's code wrote, so a main on an older Straw Boss (0.99.0 on box 2) goes through the same gate and the protocol does not change. A resident tower (`towerRuns` off) has no server intake and still gets every call.

What still wakes a run, and what is only recorded, is the table in [The logbook](../how-it-works.md#the-logbook). In short:

- A milestone wakes a run when its sender is a main a tower opened (its pane's `sb_opened_by`, or the opener's ledger). A session this tower asked (`expects.json`) wakes it with any `why`, a `shared` one too: that is its answer. Any other milestone is recorded; a sender that expected a reply is told that none comes.
- A heads-up wakes a run, after an sb notice naming both sides, when it shares a name with an open heads-up from another session (any workspace of any Herdr slot), or with the board line or open items of another main or train of the sender's workspace (where the net places the sender, which may not be the tower's workspace). Any other heads-up is recorded, and the sender gets "recorded, no clash seen" with pi-intercom's `noWake`.
- A call carrying a car slip (a `car:` line, or `car: <app> | tickets:`) or a `train:` manifest is the tower's to forward or open, whatever its `why`, so it wakes as before. So does any call with a wait or forward field (`waits-on=`, `ask=`, `relay=`, `in-reply-to=`, `fwd=`), a peer's turn (`origin=`, `remote=`), or the handover notice sb writes (`handed-to=`, or the words of an older Straw Boss's notice, which has none). A `train:` manifest is recognised before anything else in it, a car slip included; one that does not read is refused with a resend, never recorded as a heads-up.

## The entry

`logbook.json` in the folder of a Herdr slot (the state folder for the default Herdr, `servers/<hash>` for another), one file for every workspace of that slot, written by its sb server alone; a heads-up is compared with every slot's file:

```json
{ "v": 1, "seq": 42, "read": { "w15X": 40 }, "entries": [
  { "seq": 41, "kind": "heads-up", "workspace": "w15X", "label": "MP Center", "at": 1795760000000,
    "from": { "id": "01a21d65-…", "name": "Spark main" }, "text": "Now: infra-center Prometheus-only redeploy …, ~10 min",
    "resources": ["infra-center", "mp-5827"], "until": 1795760600000 },
  { "seq": 42, "kind": "milestone", "workspace": "w15X", "label": "MP Center", "at": 1795760900000,
    "from": { "id": "01a21221-…", "name": "work-on" }, "text": "MP-5741 received by Mac …", "msg": "7f3c…", "reply": true }
] }
```

`text` is the message under its header, folded and cut to 300 characters: the sender's own words. `woke: true` marks an entry whose call woke a run, with `clash` naming what it overlapped. An entry is kept 24 hours. A heads-up ends at the time its text names (`until 14:30`, `for 2h`, `~10 min`) and never later than 24 hours after it came. `msg` is the intercom message's base id (a retry's `~r<n>` removed) and `hash` the SHA-256 of its text: a retry of a message whose receipt never went adds no second entry, and the same id with other words is dropped. `read` is each workspace's mark: a woken run's brief lists the entries past it, oldest first and before the rest of the brief, and a run that ends with `tower_done` moves the mark to the last row its first brief carried whole.

Readers: the brief (`Logbook since your last run:`), `board_read` section `logbook` for a tower or a main (never in a remote turn), and `/boss board log` for the boss.

## What a heads-up names

A word of its text counts when it has a letter and a digit (`ws01`, `v3`, `MP-5827`), is a number of three digits or more (a port, a migration), or has a separator inside it (`moldplan-center`, `atlas.moldplan.app`, `feat/x`). Times, durations, two-digit numbers, command flags, and a few plain hyphenated words (`heads-up`, `follow-up`, `boss-approved`) do not count. A bare `main` or `staging` does not count either: with the branch and stage words counted, 40 of 53 heads-ups clashed on the replay below, most of them pushes to `main` of different repositories. A match on a shared name alone still wakes the tower, which judges it. That is the safe way to be wrong.

## Measured

Before, on this Mac (state folder `~/.pi/agent/straw-boss`, 2026-11-26 and 27):

- The ledger holds 243 `call_tower` calls: 124 `shared`, 101 `milestone`, 18 `blocked`. Every one of them was queued, and every one woke a run (a milestone after the 30-second hold).
- `node dist/server/cli.mjs status`, `towers[].service.localRuns` (the last 6 runs of each of 4 towers): 17 of the 24 notes say the run noted the call and found nothing to route ("no clash", "nothing routed", "no reply needed").

After: the event runs of 2026-11-26 and 27 were replayed through the new gate, in the order their events came. The replay read 146 events from the session files of 141 event runs:

| Events | Count | After |
|---|---|---|
| `milestone` from a session the tower did not ask | 47 | recorded |
| `milestone` from a main a tower opened | 8 | wakes |
| `shared` heads-up with no clash | 30 | recorded |
| `shared` heads-up that clashes with another open heads-up | 17 | wakes |
| `shared` car slip or train manifest | 11 | wakes |
| `blocked` | 7 | wakes |
| other intercom, notices, timers | 26 | wakes |

67 of the 141 runs would still start (52% fewer runs). That count is a lower bound: the board history of those days is gone, so a heads-up that matched a main's board line could not be replayed. Of the 39 runs whose handoff note is still on disk, 26 (67%) noted a call and routed nothing; of the 23 of them that would still start, 13 did.

The replay script is not part of the change; it read `tower/<ws>/runs/*.json`, the run session files, and the `boss_open_main` results in them.

## Limits and follow-ups

- A heads-up whose text names no end stays open 24 hours, and a later heads-up on the same name from another main wakes the tower until then. A milestone from the same sender does not close it: sb guesses no end from free text, and an explicit end marker would be a protocol change. This stays as it is.
- With `towerRuns` off, the resident tower gets every call, as before.

## Review round

The review of `07a463cf..3a0cce5d` (P0 0, P1 4) and its fixes, each with a test in `tests/tower-quiet.test.ts`:

- quiet-F001 (P1): two Herdr slots wrote one `logbook.json`, so two servers overwrote each other's entries, and two slots' `w1` shared entries and a read mark. Each slot's server now writes its own file; the heads-up check and `/boss board log` read every slot's.
- quiet-F002 (P1): the intake receipted a message before the gate had classified it (the net reads came after), so a server that stopped between left a seen message with no event. The gate now classifies, records, and queues or sees a call before the receipt goes; the entry carries the message id, so the sender's retry adds none.
- quiet-F003 (P1): a session the tower asked that answered with `why: shared` was only recorded. Its answer now wakes the tower whatever its `why`.
- quiet-F004 (P1): `ws01` and `ws01:5432` did not clash. An endpoint now names its host (and a local endpoint its port). The board compared is the sender's workspace's, not the receiving tower's.
- quiet-F005 (P2): the read mark moved past rows the brief left out, and past rows only a refreshed brief showed. It now moves to the last row the run's first brief carried whole.
- quiet-F006 (P2): a slip or manifest under `why: milestone` was recorded, and a `shared` manifest with a bad code became a heads-up. Both are now recognised whatever the `why`, and a manifest that does not read is refused with a resend.
- quiet-F007 (P2): the handover notice sb writes went out as a plain milestone and was only recorded. Its header now names the successor (`handed-to=`), which the gate queues.
- quiet-F008 (P2): the brief cut whole rows, which could drop the closing `»`, and the sender's name was not fenced. A row now cuts the name and the words first, then fences each.
- quiet-F009 (P2): `call_tower`'s slip note and the gate now share one recognizer (`carriesSlip` in `src/carslip.ts`). A heads-up with no end stays as it is (Limits above).

## Second review round

The review of `8cf3e232..8029f609` (P0 0, P1 1) and its fixes, each with a test in `tests/tower-quiet.test.ts` that failed first:

- quiet-F010 (P1): two heads-ups whose net reads overlapped both compared before either was written, so both heard "go ahead" and no run woke. The compare with the open heads-ups now runs after the reads, in one synchronous step with the write, under the logbook lock (`src/server/trainlock.ts`, one for every slot: each slot's sb server is its own process). The process that writes holds the lock across that step and awaits nothing while it does. A lock that stays busy for 3 s records the heads-up and wakes the run.
- quiet-F011 (P2): a retry under `~r<n>` while its first try was still being classified was a new call, so it was recorded and queued twice. The gate keys a call in flight by receiving tower, sender, and base id, and an entry by its workspace, sender, and base id; a retry with the same text shares the first try's end and receipt, and the same base id with other words is dropped without a receipt.
- quiet-F006 rest (P2): a `train:` block with neither `project:` nor `code:` became a heads-up, and a bad manifest that carried its slips was queued as a car slip. A manifest (a `train:` block, or a `train:` line beside a `project:` or `code:`) is now recognised first, then read, then queued or refused. A `train:` line with words after it and no such key is a train's own heads-up.
- quiet-F007 rest (P2): a main on 0.99.0 sends its handover notice with no `handed-to=`, so it was recorded only. The gate also recognises the words `handedNotice` has written since 0.99.0 when the session they name as stepping down is the sender's own.

## Third review round

The review of `8029f609..be739e6e` (P0 0, P1 0) and its fixes, each with a test in `tests/tower-quiet.test.ts` that failed first:

- quiet-F012 (P2): the logbook lock lived in the trains' lock folder under the name `logbook`, so `train status` listed `logbook #0` with no train, and a train step that chose the lock `logbook` waited on it. It now lives in `logbook-lock/logbook.lock` in the state folder.
- quiet-F013 (P2): a call with other words under the base id of a call in flight skipped the in-flight check when it sorted differently (a `blocked` one is queued as before), so both were queued and receipted. The gate checks the base id and fingerprint before it sorts the call.
- quiet-F014 (P3): the 0.99.0 handover notice was recognised only with a title of at most 200 characters. It is now found by its fixed sentence around the sender's own session id, whatever the title's length.
