# Device hold

Status: implemented on `feat/device-hold` (unreleased). The boss's decisions on 2026-11-26 were 「照建議做」 for D1 to D6 as recommended, and 「main 提出、你按同意」 for who starts a hold (D4).

## Problem

When the Mac's main works through a teammate's box with ally workers, the box keeps running its own intake. Its coordinators pick tickets, its `under` notices ask its own mains to dispatch, and any controller may send it worker slips. The two plans compete for the same budget, and nothing on either side shows that the box is meant to be the Mac's.

## Decision

The controller announces a hold on its own `board`, which it already sends at least every 10 minutes. The box decides in code whether to honour it. While the hold is in force, the box changes the notices it raises and the texts it sends its mains at each moment, and both sides show the hold. The hold grants nothing: no main is opened, closed, or given a tool.

These options were rejected:

- A `heldBy` field in the box's policy file would need root on the box for every hold, and the Mac would not know about it.
- A new queued kind `hold` with renewals would need the relay's kind table changed and redeployed, renewal traffic, and replay handling.

## Decisions (boss, 2026-11-26)

| | Decision |
|---|---|
| D1 | `dispatch` and an attended sender are enough authority. There is no new policy grant. |
| D2 | A hold lapses 30 minutes after the last board that carried it. There is no clock by default, and `--hours` is optional. |
| D3 | While held, the box refuses worker slips from every device but the holder. |
| D4 | A main asks with `link_request` `hold`, and the boss approves (under auto mode the request waits). A main releases its own hold without asking. The boss may also use `/boss link hold`. |
| D5 | While held, the box raises no `under` for its own mains. Its free room is told to the holder (`held-room`). |
| D6 | The box's boss can end a hold there, and the controller is notified (`hold-ended` notice). |

Every device of the team needs this build before a hold can be set. `/boss link hold` and `link_request` fail fast and name the devices that do not list `board.holds`.

## Wire

- `board` gets an optional third field, `holds: [{device, by, since, until?, role}]`, with at most 8 entries (`src/link/kinds.ts`). `device` is a 26-character id, and `by` is the holding main's board entry id (16 hex). `role` is either `holds` (the controller's claim) or `held` (the box's echo of the hold it honours). In a three-field board the second field may be empty, which means no capacity row. A hold whose role, device, or main the build does not know is dropped. A board of four fields is refused.
- The caps feature `board.holds` is 14 of the 16 slots, 15 with `hello`. The third field is written only when every roster member lists the feature in fresh caps.
- A board that carries holds goes at least every 10 minutes (`CAP_REFRESH_MS`), and its hash includes the holds.
- straw-relay needs no change.

## Who may hold

The box judges each minute in `src/hold.ts` `holdOf`, with the checks `takeUnitStop` uses:

- the box is unattended;
- the sender is an attended roster member, and the box's policy trusts it at `dispatch`;
- the sender's latest board names the box, and the board's own `ts` is at most 30 minutes old;
- its `until` has not passed;
- the box's boss has not ended it (`capacity/_hold-ignored.json`, by device and `since`, kept 7 days).

The hold in force stays. Otherwise the first `since` wins, and other claims are contested and refused. A hold that ends gets a reason: `released` (the claim is gone or replaced), `lapsed` (board age or `until`), `revoked` (trust, attended flag, or roster), or `ended here`.

## Box

- `capacity/_hold.json` holds the verdict and the controller's holding view. Sessions treat it as fresh for 5 minutes, like the device row.
- The box tells its head tower, its standing main, and each coordinator once that it is held (`moments.ts` `heldText`). A coordinator that starts on the box during the hold is told too. The end is told once with its reason (`holdEndedText`). The marks (`hold:<device>@<since>`, `holdmain:<session>`) live in `_sent.json`, so a restart repeats neither.
- `under` and `under-30m` are not raised. `stale` still goes to the tower. The main's copy ends with `HELD_CAP_HINT` and the standing main's copy with `HELD_STANDING_HINT`. `quota` and `silent` do not change.
- The worker door (`server/workerally.ts`) refuses a slip from another device: `held by <label> (<short>): its capacity is that device's`.
- The texts sent at moments are worded differently while held. These are the idle nudge (`HELD_NUDGE`), the standing wake (`HELD_ARM_TEXT`), a revive's handoff, and the local, ally, and head tower briefs (`heldLine`).
- The box echoes the hold it honours in its own board as `held`.
- After a restart the link holder gets its boards back from the relay a little later, so a holder missing from the allies keeps its hold for 5 minutes since it was last seen, and no false end is told. An end clears its own marks and throttles, so a hold that comes back is told again (review R-F001). Ends are told before a new hold (R-F003).
- On the controller, the gate on `board.holds` reads each member's last caps however old, so a teammate offline for 2 hours drops no hold (R-F002). A controller just started sends no board for 90 seconds while a member's caps are not back, rather than one without its hold.

## Controller

- `<state dir>/link/holds.json` stores `{team, device, session, since, until?}`, one entry per box. Ended entries are kept an hour, each with a reason (`released`, `lapsed`, `gone`, `ended-there`).
- The holder ends a hold whose main is missing from pi-intercom's list for 2 minutes, or whose `until` has passed. A rotation moves the hold to the successor (`src/rotclose.ts`, when the successor says it took over).
- A `hold-ended` notice from the box ends the hold as `ended-there`, and the capacity watch tells the holding main once.
- The capacity watch sends `held-room` to the holding main alone. This happens when the box echoes the hold with the same `since`, has at least 1 point of room, has load under 0.7 per core, and stays that way for 10 minutes. The holding main also gets the box's `silent` and `quota` notices, with `HOLDER_CAP_HINT`.

## Tools and commands

- `link_request` gains two actions. `hold` takes `device` and `hours?`, and the boss approves it in the dialog. `release` takes `device` and covers the caller's own hold only, with no dialog: the holder answers `noAsk` and the runtime skips the approval. A tower run cannot hold.
- `/boss link hold <box> [--main <name|key>] [--hours n]` (confirmed first), `link release <box>`, and `link holds` run on the controller. `link held` and `link held end` (confirmed) run on the box. They are `src/bosshold.ts`, posting to the GUI routes `link/hold`, `release`, `holds`, `held`, and `held-end`. A paired device's composer cannot type them.

## Views

- `board_read` has two new sections: `held` on the box, and `holds` on the controller, which says for each hold whether it is honoured and how old the box's board is. Remote rows carry `holds` and `heldBy`.
- `/boss board` prints the hold lines under its head (`hold.ts` `holdLines`).
- The head page's board fold has chips in both languages: `held by {main} on {device}`, and `holds {device} · {main} · honoured|not honoured`.

## Security

The authority is the same as a remote stop's: an attended sender, `dispatch` in the box's policy, and an unattended box. The effect is limited to fewer notices and code-written texts. A malicious `dispatch` device could idle the box, but it can already do worse. Holds reveal "A holds B since T" to teammates. No session id or path crosses the wire. Replay is bounded by the board's own `ts`, and clock skew is absorbed by the 30-minute window.

## Not done

- A contested claim is not shown in the views. Only the hold in force is.
- The README screenshots are not refreshed, since this repository has no standing rule that asks for it.
