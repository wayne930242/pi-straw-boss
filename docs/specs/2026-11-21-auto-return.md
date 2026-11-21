# Auto mode: the head switches it directly, and parked waits go back to whoever raised them (2026-11-21)

Status: implemented on `feat/auto-return` (base `main` a71441fe, 0.80.17). It amends [2026-11-09-auto-mode.md](2026-11-09-auto-mode.md) (§2, §6, §8), [2026-11-16-wait-cards-flow.md](2026-11-16-wait-cards-flow.md) (the end notice), and [2026-11-07-wait-cards.md](2026-11-07-wait-cards.md) (its auto mode amendment). The standing pane's stand-in is in [docs/how-it-works.md](../how-it-works.md#the-standing-pane).

## Boss words (binding, 2026-11-21)

> 「Straw boss 有個功能要改 1. 主塔台應該要能切換 auto 模式 on/off 2. 塔台 waiting 不要造成主塔台 waiting，除非主塔台真有可互動內容 3. 塔台的等待卡片的預設行為應該是要求原塔台再提、再問一次。不需要塔台傳達問題並且回覆給塔台。應該 auto off 以後就直接發回原 agent 請他們再問、再要求一次。」

## Decisions (boss, 2026-11-21)

| # | Question | Decision |
|---|---|---|
| AR-D1 | Does the head's `boss_auto({ on: true })` still stage a request for a confirm? | 「on/off 都直接切」: both directions switch at once. |
| AR-D2 | Which cards make the head's pane `blocked`? | 「對，只算主塔台自己的」: only the head's own open cards. |
| AR-D3 | Which cards go back when auto mode ends? | 「只套用 auto 期間擱置的卡片」: the cards parked during the period, including those open at the switch on. |
| AR-D4 | A raiser that is gone when its card goes back? | 「直接結案並記錄」: close the card and record it. |

## AR-D1: the head switches auto mode on at once

`boss_auto({ on: true })` switches auto mode on in the same call, with no staged record and no confirm. The guards are those of `on` before and of `off` today (auto-mode spec §2):

1. the caller is the head tower (`who.kind` is `head`); a workspace tower's token is refused;
2. the turn's starter is reported by the run's extension (`turn`, or the typed line with its `seq`), never by the model, and it is a `boss` event the run took that is no press, or a line the boss typed at the head pane;
3. the server reads that text itself against the on-list; a question, a negation, both directions in one line, and words used before are refused.

A request staged by another door is cleared by the switch. `off` is unchanged. `/boss auto on` in a terminal still stages and draws its own confirm, and the GUI's two taps still switch; the GUI's confirm button stays for a request staged over the socket. A secondary Herdr slot still refuses `boss_auto`. The head pane's own terminal confirm (`bossconfirm.ts`) is gone, since nothing the head does stages now.

**Security.** The confirm (D9 of the auto-mode spec) was the one step a misread of the boss's matching line by the model could not skip. That residual is now open for `on` as it always was for `off`: the model can call `boss_auto` against what the boss meant in a turn whose own text matches the on-list. Injected text still cannot pass, because the server reads only the boss's own event or typed line. Every switch is still recorded with its requester, notified to every pane, and listed. The staging and confirm over the control socket are unchanged, so a same-user process still needs two forged steps to turn auto mode on that way.

## AR-D2: the head's stand-in waits only on its own cards

The head pane's stand-in is `blocked` only while one of the head's own wait cards waits for the boss (open, not pressed). A workspace tower's card no longer makes it `blocked`; the head's stand-in names those cards as a note, after its own: `standing by · 3 cards wait at other towers`, `1 card waits · 2 cards wait at other towers · 1 queued` (zh-TW: `其他塔台有 3 張卡片等你`). Each workspace tower's own pane is unchanged.

## AR-D3: a parked card goes back to its raiser when auto mode ends

When auto mode ends by any door, the server closes every parked card that still waits (`open`, never pressed) in the same step as the switch, so no press reaches it for the boss after he is back, and sends it back:

| The card | Goes to | How |
|---|---|---|
| raised by a session (a main, a member, another tower for the head) | that session | One intercom message from the tower's identity to the raiser's session id (never by name), under a new header kind `wait_returned` with `wait=W<n>`, `reply=none`. A tower raiser is told to record the wait again or ask as before; any other raiser to ask the boss itself with `ask_user_question` (or `call_tower` if it cannot). |
| the tower's own (`self`, or a legacy wait with no raiser) | that tower | A notice event for its next run: record the wait again with `tower_memory` if it still needs the boss. |
| the head's own | the head tower | The same notice, in the head's queue. |

- **The card's record.** `state: "resolved"`, `ended`, `returned: "raiser" | "tower" | "gone"`, and an outcome: `returned to <raiser> to ask the boss again (auto mode ended)` or `returned to the tower to ask again (auto mode ended)`. It stays 24 h like any resolved wait. The GUI's card reads `When auto mode ended: <outcome>` (zh-TW `自動模式結束時：<outcome>`), not "the tower confirmed".
- **Not returned.** A card raised while auto mode is off, and any card that was not parked, is unchanged: the tower relays it as today, and `/boss memory done|choose|decline W<n>` and `boss_wait_ask` still reach it. A parked card the boss answered while away (a press, or a reply in its box) is the tower's to resolve: it only loses the flag, as before.
- **The tower relays nothing.** No `wait_card` is sent for a returned card, and the tower gets no event for a card a session raised.
- **The return list** (`auto-report.json`) lists each returned card with where it went (`returned`). `/boss auto off` prints `Parked waits (n) went back to whoever raised them, to ask you again directly; sb closed the cards:` and each row ends with `→ back to <raiser>`, `→ back to the tower`, or `→ closed: <raiser> is gone`. The GUI's return panel shows them as lines, not as cards to press; a list written before this change still draws its cards. The head's end event says the parked waits went back to whoever raised them.
- **The messages.** The raiser of a parked card is told at the switch on that it comes back as a `wait_returned` message when the boss is back, and every session's end notice says the same, with how its kind asks again.
- **Where it runs.** `src/server/autoreturn.ts` (the delivery), `autotower.ts` `returnParked` (the memory change), called from `automode.ts` `switchOff` through `towers.ts` `returnParked`. A secondary Herdr slot returns its own towers' cards the same way when it sees the primary's switch off; those rows are not on the primary's return list.

## AR-D4: a raiser that is gone

A raiser that had left the net when the card was recorded (`from.gone`), one that is not live when the card goes back, a message the broker does not take within 5 s (`NOTICE_WAIT_MS`), and a tower the server no longer serves all close the card with nothing left for the boss: `returned: "gone"`, outcome `closed: <raiser> was gone when auto mode ended` or `closed: <raiser> could not be reached when auto mode ended`. The return list is written at the switch with the routes known then, and again once every message is answered, so a raiser found gone afterwards is listed as closed. The server logs one `wait-returned` line per message with its delivery.

## Amendments

- **2026-11-09-auto-mode.md, §2.** "On is never one step (D9)" now holds for the control socket only: the head's `boss_auto` switches on at once (AR-D1), as the GUI's two taps do. The head pane's terminal confirm and the GUI button's head wording are gone; the GUI's confirm button names a staged request without saying who asked.
- **2026-11-09-auto-mode.md, §6.** The `wait_parked` message says the card comes back as a `wait_returned` message, not that its answer comes as a `wait_card`.
- **2026-11-09-auto-mode.md, §8.** Items 1 to 5: the parked waits are no longer made ordinary again for the boss; they go back to their raisers, closed (AR-D3, AR-D4). The GUI panel lists where they went; the head does not present them.
- **2026-11-16-wait-cards-flow.md, Amendments.** "Never re-ask a parked wait with ask_user_question" is inverted: a parked wait comes back to its raiser, who asks again then. `boss_wait_ask` stays for cards that were not parked.
- **2026-11-07-wait-cards.md, Amendment: auto mode.** "When auto mode ends the cards are ordinary open waits again, listed on the return list" becomes: they are closed and go back to their raisers.
- **The standing pane** (how-it-works): the head's stand-in counts its own cards only (AR-D2).

## Tests

- AR-D1: `tests/auto-state.test.ts` and `tests/auto-head.test.ts` ("AR-D1: …"): the head's 我要睡了 switches on at once, with no pending record; an event works once; refusals unchanged.
- AR-D2: `tests/server-standing.test.ts` (`standinReport` with the other towers' count) and `tests/head-service.test.ts` ("AR-D2: …"): a tower's card leaves the head `idle` with the note; the head's own makes it `blocked`.
- AR-D3, AR-D4: `tests/auto-towers.test.ts` ("AR-D3: …", "AR-D4: …"): the main gets one `wait_returned`, the card is closed before any press, a card recorded after the end stays open, an answered parked card is not returned, a gone raiser and a refused message close the card and the list is written again; `tests/auto-gui.test.ts`: the panel's lines and the card's returned line; `tests/auto-cancel.test.ts`: the end notice per kind; `tests/prompts.test.ts`: the prompts' lines.
