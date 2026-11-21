# An operate probe that gets no answer, and a pane that moved (2026-11-21)

Status: implemented on `fix/operate-probe`. Amends [2026-11-07-link-operate.md](2026-11-07-link-operate.md) §7 (input safety on a box): the refusal words and how long the box waits for a session's editor check.

## What happened

On his phone, the boss could not send anything to an ally main on an unattended box: the composer showed `refuse_operate_unread` ("The box could not tell what Enter would run in this session's editor"). The main was in the middle of a turn, running `bash`. Two things in the box's sb server can give that answer even when the editor is readable:

1. The hub waited 1 s for the bridge's answer to a probe (`PROBE_MS` in `src/dialogs.ts`). A session in a turn, or a loaded box, can keep the bridge's event loop busy for longer than that. No answer was counted as an unreadable editor (`operateRefusal(undefined)` is `unread`).
2. The hub found a session's bridge only when the pane the bridge reported, `HERDR_PANE_ID` from when the session started, was the pane where pi-intercom placed the session. Herdr gives a pane a new id when it moves it to another tab or workspace. pi-intercom follows the session by its session file and reports the new id, but the bridge keeps reporting the old one. After a move, the hub could never reach the session's bridge again, and every probe got no answer.

## Boss words (binding, 2026-11-21)

- 「直接修，兩種都處理」: fix it directly, and fix both causes. The safety checks themselves stay as strict as they are.

## Decisions

| # | Decision |
|---|---|
| P1 | A probe that gets no answer at 1 s is sent again with the same probe id, and the hub waits 3 s more. The first answer to either send is the one used. That is 4 s at most: a broker round trip and an editor read take well under 100 ms on an idle box, and 4 s is still well inside the link's 20 s request (`REQUEST_MS`) and Herdr's 15 s calls. A probe only reads, so sending it twice changes nothing on the bridge. This applies to every probe, so a local page's Enter also gets the second send before it asks the `unread` confirm. |
| P2 | No answer at all (the bridge could not be reached, or it stayed silent through both sends) is a new reason word, `noanswer`, and it is checked before every other operate refusal (`operateRefusal`, `operateKeyRefusal`, `operateRawRefusal` in `src/probe.ts`). The page says that the session did not answer in time and to try again. `unread` is now only for a bridge that answered `unknown`, or answered `command` without the flags. The rules for `unknown`, shell lines, /boss commands, other slash commands, and drafts are unchanged, and nothing is ever sent without a positive answer. |
| P3 | The hub matches a bridge to a unit using the pane where intercom places the bridge's session in this reading, plus the session file the bridge reports. The pane the bridge reports itself is no longer used for this match. The check that a dialog is open (`has`, which can only add refusals) counts a bridge on either pane. |

## Why P3 is no weaker against a forged bridge

The process that sends a dialog list also writes the pane in it, so that pane never proved anything. The old check required the pane to equal intercom's placement of the sender's session, and a fake bridge could pass that by writing the placed pane. The binding still depends on what it depended on before: the broker's placement of the sending session (`fromSessionId`, which comes from the broker), and the registry's unit on that pane, whose session file must be the one the bridge reports. An impostor still has to get intercom to place its own session on the victim's pane, exactly as before. The secret rule in SB-F001 (no secret is ever answered from a page) does not depend on the pane, so it is unchanged.

## Not changed

- Gate Allows (`AllowNote.pane`, `src/server/allows.ts`) and the monitor list (`hub.monitors()`) still use the pane the bridge reports. Ally runs are opened by the server and are not moved.
- The bridge still sends its `HERDR_PANE_ID` as before. Older servers still use it.

## Tests

`tests/dialogs.test.ts` (a busy bridge that answers at 1.5 s is used, a silent one is sent the probe again at 1 s and given up at 4 s, a moved pane is reached only where intercom places it now), `tests/operate-input.test.ts` (no answer gives `noanswer`, answered `unknown` gives `unread`), `tests/termwords.test.ts` (the page has words for `noanswer`), and `tests/server-operate-wiring.test.ts` (a box with no bridge refuses a key with `noanswer`).
