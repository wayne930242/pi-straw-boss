# Idle wrap-up, and boss questions asked by the main (2026-11-25)

Status: implemented. Part 1: `src/wrapup.ts`, in [docs/how-it-works.md](../how-it-works.md#wrapping-up-an-idle-main). Part 2: `src/bossask.ts` and `call_tower`'s `boss` field (0.91.0; it replaced 0.90.0's prompt rules), in [docs/how-it-works.md](../how-it-works.md#when-a-main-calls-the-tower).

## Part 1: an idle main wraps up

### Boss words (binding, 2026-11-25)

> 「如果 herdr idle 一陣子，可以問 agent 是否要收工。如果 agent 認為可以收工（如果可以繼續做，那就繼續做或是清理 todo），就 ask user，這會讓狀態變成 waiting。如果 user 同意收工，那就走收工流程（現在有流程嗎？看要不要也訂下來，像是清理 board 和回報塔台等等），然後用 herdr 把自己的 pane 關掉（僅限 user 同意）」

### Decisions

| # | Question | Decision |
|---|---|---|
| WU-D1 | How long idle before the nudge? | 30 minutes (boss). |
| WU-D2 | Where is the boss asked? | In the main's own pane, so Herdr shows it waiting; not as a wait card (boss). |
| WU-D3 | What does wrap-up leave behind? | A daily memory entry, written by the agent before `boss_wrap` (boss); sb does not depend on a memory extension. |
| WU-D4 | Auto mode? | No nudge and no wrap-up while it is on: the boss is away; wait until he is back (boss). |
| WU-D5 | Who keeps the clock? | The main's own session (left open by the brief). It sees each turn start and settle, so the turn the nudge itself starts is not counted as new work; the sb server's minute look sees only states, and a short turn falls between two looks. |
| WU-D6 | Which todos block `boss_wrap`? | Every one that is not completed or deleted (left open; the simplest rule). A task reported blocked to its owner is deleted first; a task that still waits on someone means the work is not done. |
| WU-D7 | What else blocks it? | An open dialog, a running monitor, an active pi-loop-monitor loop, a `boss_watch`, a running subagent. Intercom asks owed and worktrees made are not known to sb: the nudge and `prompts/main.md` name them. |
| WU-D8 | Which mains? | Kinds `coordinator` and `integrator`. Not a standing main (it has no end), a member, a train, a tower, or a main opened for a teammate's device (its device's stop or the tower closes it); `boss_wrap` is refused in a teammate's remote turn. |
| WU-D9 | The opener? | When a tower opened the main for a session (`sb_opened_by` is a session id), that session gets the summary too, as a plain intercom message; the tower gets it as `call_tower` `why: milestone`, `reply: false`. |
| WU-D10 | A tower that does not take the milestone? | Nothing closes, and the result says so; a later `boss_wrap` asks the boss again. |

### Behavior

1. **Nudge.** A coordinator or integrator main idle 30 minutes since its last turn settled gets one `straw-boss-wrap` message that starts a turn. It says: if work remains, go on or clean up stale todos; if it waits on someone other than the boss, set that todo's `metadata.waitsOn` and stop; if done, answer the intercom asks it owes, remove its worktrees, complete or delete every todo, stop its monitors and loops, write a daily memory entry if it has a memory tool, and call `boss_wrap`. At most one per idle period: the next comes after a turn that the nudge did not start, and 30 more idle minutes. None while a dialog is open or Herdr shows the pane blocked, while a monitor, loop, `boss_watch`, or subagent of the main runs, or while pi has messages queued. Under auto mode the clock stops; it starts again when auto mode ends.
2. **`boss_wrap({ summary })`.** One paragraph, 1 to 800 characters (whitespace folded). Checks in order: the role (WU-D8), the summary, auto mode (refused: "auto mode: the boss is away; wrap up when he is back"), a terminal to ask in, then every open todo by id, messages queued in pi, and everything that runs (WU-D7), all named in one refusal. Then `ctx.ui.confirm("Wrap up <name>?", summary)` in the pane; the GUI relays it as any dialog. No (or Esc): nothing closes, and no nudge comes this idle period. Yes: the same checks again, since the dialog may stand for hours (review RV-F001): a message that queued or a monitor that started meanwhile closes nothing and sends nothing. Then the milestone to the tower and the opener (WU-D9), the board cleared, and the close of `/boss close` (`closeSelf`): pi quits when the turn ends, and its pane closes, with its tab when emptied.
3. **Prompt.** In 0.90.0, `prompts/main.md`'s "Done when" line carried the steps (every todo completed or deleted, a daily memory entry, `boss_wrap`). Since 0.91.0 it is 0.89.0's line again, and the steps reach the main only when they are needed: in the nudge (`NUDGE_TEXT`) and in `boss_wrap`'s description and results (boss 2026-11-25, part 2 below). A main that finishes before 30 idle minutes gets the nudge later; that is accepted.

## Part 2: the boss question is drawn by code

### Boss words (binding, 2026-11-25)

> 「waiting card 我現在其實覺得稍微難用，要和 ask user question 好好整合，塔台每次問問題我都不知道是哪個 agent 問的，不知道能不能把 waiting card 發還回 main agent？」

0.90.0 answered this with prompt rules: `prompts/main.md` told a main to ask the boss itself with `ask_user_question` (and to park it with `blocked` under auto mode), `prompts/tower-run.md` told the tower to send a local main's boss question back to it, and `call_tower`'s description said the same. That grew main.md and planning.md from 10,177 to 10,538 characters. The boss then asked for it in code, and for rules to come when they are needed:

> 「main 的提示好像太多，而且「自己問我」應該做成程式碼，直接從程式碼發出而不是讓他依據這個問，至少也可以在需要問我的時候當下再給提示詞。收工規則也可以在提示收工的時候再給。請注意這個原則，提示詞可以逐步交付」

Principle: the standing role prompt holds only what every turn needs; a rule needed at one moment is delivered at that moment (a tool description, a tool result, sb's wake text), and what code can do, code does. 0.91.0 replaced 0.90.0's prompt approach: main.md's `call_tower` and "Done when" lines and tower-run.md's `blocked` paragraph are 0.89.0's again (main.md and planning.md 10,167 characters), and the question is a field of `call_tower`.

### Decisions

| # | Question | Decision |
|---|---|---|
| BQ-D1 | Where does a main put a decision only the boss can make? | `call_tower` with `why: blocked` and `boss: { question, options? }` (question 1 to 500 characters, at most 8 options of at most 120; the schema carries no descriptions, `call_tower`'s description names the field in one clause). It does not go with `waitsOn`, `linkWait`, or `standing`. |
| BQ-D2 | When is it drawn? | For a tab's main (not a train or a tower) in its own turn (not a teammate's remote turn), with auto mode off, on an attended device, with a terminal. Then nothing goes to the tower. |
| BQ-D3 | How is it drawn? | In the main's own pane: `ctx.ui.select` of the options and a last row "Type another answer…" (which opens `ctx.ui.input`), or `ctx.ui.input` alone when there are no options. Herdr shows the pane waiting. The same question goes to the GUI and paired devices as sb's own questionnaire (`src/owners.ts` `bossQuestion`, prefix `straw-boss:boss`): one question, its options, and the boss's own words, answered as `ask_user_question`'s questionnaire is, or cancelled; the first answer, there or in the terminal, wins and closes the other. Review F001 (0.91.0): the first build relayed only the select, so a typed answer and a question with no options were terminal-only, a step back from `ask_user_question`. `call_tower` having a contract owner drops the wrap's twin select. |
| BQ-D4 | The result? | The boss's choice or typed answer, quoted as his, and that nothing went to the tower. Esc or a stopped turn: the boss did not answer, nothing was sent. |
| BQ-D5 | Auto mode? | On: nothing is drawn; the question goes to the tower as `blocked` after the message (`For the boss: …`, `Options: …`), the tower parks the card, and it comes back as `wait_returned` when auto mode ends; the result says so and that the main asks again then with `call_tower boss`. Starting while the dialog is open: sb looks at `auto.json` every 500 ms while the dialog stands and closes it, then sends as when it was on; no typed-answer input opens once auto mode is on. Auto mode's own transition may cancel the questionnaire first; `auto.ts` gives it no cancel text and leaves a `call_tower` whose result says it went to the tower (`details.boss: "tower"`) without a cancel or refusal line (review F002). |
| BQ-D6 | Members, trains, towers, a teammate's turn, an unattended device, no terminal? | Nothing is drawn: the field is accepted and folded into the message to the tower, as a `blocked` call was before (left open by the brief; folding keeps the question instead of refusing a call the caller cannot fix). A tower run's `call_tower` (runmode.ts) has no drawer and folds it the same way. |
| BQ-D7 | `ask_user_question`? | Still usable by a main; no standing rule about it. Under auto mode its refusal (`src/autotext.ts`, kind `main`) says to park the decision with `call_tower why: blocked` and the decision in `boss`. One way to ask again (review F003): `wait_returned` (`server/autotower.ts` `returnedText`), auto mode's end notice, and main.md's `wait_card` line all say `call_tower` with `boss`. |

### Behavior

1. **Prompts.** `prompts/main.md`'s `call_tower` line and `prompts/tower-run.md`'s `blocked` paragraph are 0.89.0's: `blocked` covers "a decision your authorizations do not cover", and the tower records a boss-only decision as a wait for the boss. A local main's boss question no longer reaches the tower while auto mode is off. The one change past 0.89.0 is the tail of main.md's `wait_card` line: a `wait_returned` wait is asked again with `call_tower` `boss` (review F003).
2. **`call_tower`'s description.** `blocked (you wait on someone outside your tab, or on a decision your authorizations do not cover; the boss's own decision: boss, asked in your pane)`.
3. **Code.** `src/bossask.ts` (`createBossAsk`, `bossOf`, `withBoss`) and `src/link/waitcall.ts`; the guidance for the moment (under auto mode, the re-ask on `wait_returned`) is in the tool's result.
