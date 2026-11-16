# Wait cards one after another in the terminal (2026-11-16)

Status: implemented on `feat/wait-cards-flow` (base `main` 0a243f17, 0.80.7). Related: [2026-11-10-wait-cards-tui.md](2026-11-10-wait-cards-tui.md) (`/boss wait`, the standing pane's block and numbered picker; its decision 2 is amended here), [2026-11-09-auto-mode.md](2026-11-09-auto-mode.md) (the end notice and the refused tools; amended here), [2026-11-07-wait-cards.md](2026-11-07-wait-cards.md) (the card and the press).

## Boss words (binding, 2026-11-16)

- 「sb 的 塔台卡片依然很難從 herdr tui 裡面操作，閒置情況時，不能一樣顯示成可以簡單回答的 tui 卡片、一張接一張嗎？開啟塔台之後不能重新用 ask user 再問一次嗎？」
- 「其實不知道 tower 的 idle mode 也能不能允許直接在上面回答問題，不需要開啟塔台 tui」

## Intent

The boss answers open wait cards in Herdr's terminal the way he answers `ask_user_question`: a card, arrow keys, Enter, then the next card, with no `W<n>`, no `/wait`, and no list in between. He can do it in the tower's idle pane without waking a tower run. When he is with a tower run or a main, that agent may have sb put the card in front of him again, and his answer resolves the card everywhere (the GUI, other panes, the raiser): the first answer wins.

## Decisions (boss, 2026-11-16)

Scope: A, B, and C below.

| # | Decision |
|---|---|
| D1 | Auto-focus (none on unattended). |
| D2 | Hold every event (60 s idle / 5 min cap). |
| D3 | The model may open a card dialog via `boss_wait_ask` (only his keys choose). |
| D4 | A run draws it only when his last words in that run came from this pane. |
| D5 | Numbered fallback on win32. |
| D6 | `boss_wait_ask`. |

## A. The idle pane's card view and the wake hold

The tower prompt is plain Node (`src/towerprompt/`; the server bundle refuses pi packages), so the view is its own: `cardview.ts` holds what is shown and what a key does, `prompt.ts` owns the terminal.

- **Where.** A terminal that reports keys: both streams a TTY, `TERM` not `dumb`, and not win32 (D5: until one round on the Windows VM passes). Elsewhere the block and the numbered picker of the 11-10 spec stay as they were.
- **Focus (D1).** When a card of this pane's tower is open, the first card is drawn with no command typed and the view has the card keys. On an unattended device (the poll's `unattended`) no card is drawn on its own; `/wait` opens the view.
- **Keys.** ↑↓ or a digit marks a row; no row is marked at first. Enter presses the marked row and the next card is drawn; after the last one the view says none is left. ←→ go to another card without pressing. Esc gives the keys back to the message line, and `/wait` brings the cards back. A printable key that is no digit goes to the message line. An empty Enter with no row marked wakes the tower, as before. Ctrl+C and Ctrl+D leave the pane.
- **Skip and reply.** Skip opens a reason field on the line, then a confirm (Enter confirms, Esc cancels). Reply opens a text field; Enter sends it to the card's tower with `answers`.
- **Only a typed key presses.** A card key is a single typed key on an empty message line. A paste is text inside a field; at a marked row or the confirm it ends the view with nothing pressed.
- **The here mark** opens at the first card key, not when a card is drawn, so a paired phone's key pad keeps writing to the tower while the boss has not touched the cards. A mark that cannot be opened refuses the view.
- **Elsewhere first.** A press the server refuses (409) is shown with its reason, and the next card is drawn. A card that leaves the list while shown is replaced at the next poll with a line that says so.
- **The wake hold (D2).** From the first card key until the last card, Esc, a message, or 60 s without a card key (`QUIET_MS`), the prompt's `prompt-poll` carries `answering: true`. While it does, `runs.ts` holds the wake of that tower for every event: until 10 s after the last such poll (`TIMERS.answer`), and never past 5 minutes after the first of the stretch (`TIMERS.answerMax`). A poll that says the boss is done ends the hold at once, and one run takes every event that waited. `wakeAt` is never before the hold's end, so `startsWithin` and the type gate's `run-soon` stay true; `typegate.ts` is unchanged. The poll's answer says `holding` while events wait, and the state line shows it. A raiser is told at each press, since the `wait_card` message is sent by the press itself.
- **A run that starts anyway** (the hold lapsed, the service is ending) drops the view as it drops the picker: a press already sent is answered first, and nothing on the line is posted.

## B. `/boss wait` goes on to the next card

In `waitcmd.ts`, after a press, a skip, or a reply, the dialog of the next card that still waits opens instead of the list. A card among others offers **Next card** and **All cards**. The list comes back for the way back, a refused press, and a skip or a reply not gone through with. A run's pane shares the code.

## C. `boss_wait_ask`

An agent has sb show the boss open wait cards again; it cannot ask them itself with `ask_user_question`, since the model would word the options and nothing would tie the answer to `W<n>`.

- **Schema.** `boss_wait_ask { ids?: string[] }`, 1 to 4 ids (`W<n>`). Without `ids`: every open card in the caller's scope, one after another.
- **Scope.** A main: the cards it raised (`card.from.id` is its session id). A local tower run: its tower's cards. The head's run: any tower's.
- **Who has it.** Mains (`src/tools.ts`), local and head runs (`runallow.ts`; registered in `runmode.ts`, since it draws a dialog and is not proxied). Not ally runs, subagents, trains, or the resident tower.
- **Drawing (D3).** The card dialog of `/boss wait` (`card` of `waitcmd.ts`): terminal-only, as the boss's own command, inside the here mark. The model words nothing and chooses nothing. The press is a session's request with the hello secret and `via: "ask"`; a run's token is never attached, and `tower-memory` and `boss-waits` stay refused to run tokens.
- **Refused**, with nothing drawn: auto mode is on (it is in `WAITING` of `auto.ts`, and an open dialog ends when auto mode starts); an unattended device; a session without a screen; a hand run outside a turn the boss started; a run when the boss is not at its pane (D4); a card the boss left with Escape in this session within 10 minutes.
- **At the pane (D4).** A run draws the card only while the boss's last words in it came from its pane: typed in the run's pi, or a `boss` event the server marks `door: "pane"`. The pane's tower prompt says that of the lines posted there and of a card reply to its own tower; a run's pane says it of a reply to its own tower; `head-event` carries it for the head's own pane. A reply to another tower's card names no door, and the GUI's composer and another pi name none. A press is his button, not his words, and moves nothing.
- **First answer wins.** Beside an open dialog the list is read every 2 s; a card pressed or resolved elsewhere ends the dialog and the result says so. A press that loses the race gets the server's 409 text.
- **One notice.** The press carries `asker`. When it is the card's raiser, the server sends that session no `wait_card` and records the delivery as `asked`: the tool's result is the answer. The tower's event goes as for every press.

## Amendments

- **2026-11-10-wait-cards-tui.md, decision 2** ("A run's model gets no press"): a model may now decide when a card is shown, through `boss_wait_ask`. It still neither words the card nor presses it; only the boss's keys at this computer press.
- **2026-11-09-auto-mode.md, §8 item 5** (the end notice): "do not ask again what you parked" becomes "Never re-ask a parked wait with ask_user_question", and a main or a tower run is also told of `boss_wait_ask`. `boss_wait_ask` joins the tools refused while auto mode is on.

## Rule texts

`src/autotext.ts` `offNotice`, `prompts/main.md`, `prompts/tower-run.md`, `prompts/head-run.md`, and the return list's hint (`src/server/autotower.ts`: "Answer them at the tower pane, with /boss wait, or in the GUI:"). The resident `prompts/tower.md` is unchanged: it has no such tool.

## Security

- No new press authority: every press is the server's `press` op, asked with the hello secret, under the here mark, by a typed key. A paste, a phone's key pad after the mark opened, and a model's arguments press nothing.
- `door: "pane"` is the word of a hello-secret client (the prompt, a run's pane). It decides only whether a run may draw a card for the boss, never a press.
- An unattended device draws no card on its own and refuses the tool.

## Left open

- The card view on Windows (D5) waits for one VM round.
