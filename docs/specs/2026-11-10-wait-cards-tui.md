# Wait cards in the terminal, and one card look in the GUI (2026-11-10, todo #144)

Status: spec, not implemented. Base: `main` f807db69 (0.70.0). Related: [2026-11-07-wait-cards.md](2026-11-07-wait-cards.md) (the card, the press; amended here), [2026-11-09-auto-mode.md](2026-11-09-auto-mode.md) (§6 parked cards, §7 the label, §8 the return list; amended here).

## Boss decision (2026-11-10, all three)

1. **`/boss wait` in any pi.** It lists the open wait cards (every tower and the head, or one with `-w`). The boss picks a card, then an act (done, an option, decline with an optional reason, restate, secret start) in `ctx.ui.select`. Nobody types or remembers a `W<n>`. It uses the server's `press` op, the one behind `/boss memory done|choose|decline|restate W1` (`src/memorycmd.ts:175-195`, `src/server/waitpress.ts`). `/boss memory …` keeps working.
2. **The tower's standing pane.** It shows the open cards, and the boss presses them there. Only the human's typed input may press. The pane holds either the stand-in prompt or a tower run's pi. A run's model gets no press. *Amended 2026-11-16 ([wait cards flow](2026-11-16-wait-cards-flow.md), D3): a model may have sb show a card with `boss_wait_ask`; it words and presses nothing, and only the boss's keys choose.*
3. **GUI.** The wait card uses the alert confirm card's component and style (the dock dialog's question panel, `gui/ask.ts`) in Standard, Geek, Raven, and Zen. It keeps auto mode's parked label and the 44 px phone targets.

## What sb has today

- **The press** (`waitpress.ts`) is one op of the memory route. The control socket's `tower-memory` carries it (`src/server/main.ts:505`). A run token is refused there: `tower-memory` is not in any list of `src/server/rungate.ts`, so the default refuses it. Under auto mode the server refuses `act: "secret"` (`waitpress.ts:138`).
- **`/boss` in a run** is refused whole: "A tower run takes no /boss command" (`src/boss.ts:80`). This covers local, head, hand, and ally runs.
- **A run's code already makes token-less requests** with the hello secret. The head pane's auto confirm sends `auto-confirm` that way, because a run token may not confirm (`src/runmode.ts:225-229`, `src/bossconfirm.ts`).
- **Events reach a run's model** as `pi.sendMessage` custom messages (`runmode.ts:323`), never as typed input. pi dispatches an extension command only from `prompt()` with `expandPromptTemplates`. That flag is on for the editor's input and off by default for `sendUserMessage` (pi 1.3.0 `agent-session.js:1611`, `:1904`). A model has no tool that types into the editor: a local run has no `bash`, so it cannot use `herdr pane send-text`.
- **Terminal-only dialogs.** `terminalOnlyOpts()` (`src/intercept.ts:26`) marks a dialog that the wrap does not relay. The here mark (`src/heremark.ts`) keeps a paired device's key pad from typing into the pane while a screen is open (Escape only).
- **The stand-in prompt** (`src/towerprompt/`) is a node line reader the server types into the idle standing pane. It is not a pi, and no model reads its input. It polls `prompt-poll` with the hello secret (`serversource.ts`) and holds no run token. Its `PollAnswer` (`source.ts`) carries no waits, so the pane shows none today.
- **The GUI card** (`gui/waitcard.ts`) has its own look: `.wait-card .wc-*` in `gui/style.css:403-428` and `gui/zen.css`. Geek and Raven have no rules for it. A unit's question in the dock is `ask.ts`: a title, a radiogroup of `button.ask-opt` rows, and `.ask-acts` with Send and Cancel. Every theme already styles it (Raven's ornaments are at `raven.css:409-411`, Geek's checked row at `geek.css:110`).
- **The parked label is not on `main` yet.** At f807db69 the snapshot carries `BossWait.parked` (`src/net.ts:39`), but no GUI file draws it. Auto mode's GUI phase 2 (task 5b) is on `feat/auto-mode-gui` (27e3e6c8, not merged). It adds the card's `wc-parked` mark with `wait_parked`, the parked secret line `wc_secret_parked`, and the silence (`gui/waitcard.ts`, `waitcardmodel.ts`, `style.css`, the messages).
- **A head wait says 塔台.** The card's words name the workspace tower (`wc_b_reply` 回覆塔台, `wc_told_both`, …; `gui/messages/zh-TW.json:1030-1081`), and Raven renders them 管家 (`gui/themes/raven/sentences.ts:77-87`). A head card should say 主塔台, and in Raven 鴉閣.

## Design

### 1. The list: one server read

The server gets a new control command, `boss-waits { workspace? }`, read-only. It answers:

```json
{ "ok": true, "auto": { "on": true, "since": "…" },
  "towers": [{ "workspace": "head", "label": "主塔台", "head": true, "waits": [ { "id": "W3", "text": "…", "at": "…", "card": {…}, "press": {…}, "parked": true, "answered": "…" } ] }] }
```

- **Which waits.** Boss waits that are open or answered, never resolved or expired. The head comes first, through `HEAD_KEY` as `towers.memory` reaches it. The towers come from the services (`towers.ts:1187`), each exactly once. Newest first within a tower.
- **The rows** are `memoryView` entries, cleaned again as `/boss memory` cleans them (`tidy`, `memorycmd.ts`). C0 and C1 controls, ESC included, are removed, and `command` keeps its line breaks only. Cards are never cut: this is one request, not the snapshot.
- **Run tokens are refused.** The new command is in no list of `rungate.ts`, so the default refuses it. A test pins this.

A **digest** of the pane's own tower goes on the polls: `prompt-poll`'s answer and a local or head run's `run-poll` answer gain `waits: { id, type, do (cut to 120), from?, parked?, pressed? }[]` (at most 12, the memory's cap) and `auto: boolean`. An ally run's poll gets none. One builder, `src/server/waitlist.ts`, makes the list and the digest.

### 2. `/boss wait` in any pi

`/boss wait [-w <workspace id | label | head>]`. It is new code in `src/waitcmd.ts`, with the dialog functions passed in, as `memorycmd.ts` takes `ask`.

1. **The card list.** One row per card, in a `ctx.ui.select` titled `等你處理（3）` / `Waits for you (3)`. A row reads `［主塔台］需要你處理：<do>・由 mp3946-print・12 分前`, plus `［已暫放］` when parked and `（你已回覆）` when answered with no press. A single card skips the list. With no cards it says `沒有等你處理的卡片。` / `No wait card is open for you.`
2. **The card and its acts.** A second select. Its title is the whole card (what happened, what you do, where, after that, raised by), drawn as `/boss memory` draws a row's detail. The acts by kind:

   | Kind, state | Acts |
   |---|---|
   | action | 我做完了 · 略過 · 回覆塔台 · 切到 \<raiser\> 的分頁 · 返回 |
   | choice | one row per option, `<label> — <then>` · 略過 · 回覆塔台 · 切到 … · 返回 |
   | secret, not asked | 開始輸入（請 \<raiser\> 開啟輸入框）· 略過 · … |
   | secret, asked | 我輸入好了 · 略過 · … |
   | legacy | 請塔台重寫成卡片 · 略過 · 回覆塔台 · 返回 |

   - **Press acts.** Done, choose, decline, restate, and secret send `tower-memory { op: "press", … }`, exactly as `runMemoryCommand` does. The result line reuses its words (`pressed`, `told`, `notReached`).
   - **略過** asks `ctx.ui.input("原因（選填）")`, then `ctx.ui.confirm("確定略過？塔台和 <raiser> 會知道你不做這件事。")`. Only a Yes sends the press. This is WC-D1's two steps.
   - **回覆塔台** asks `ctx.ui.input` and posts the words as `tower-event` with `answers: "W<n>"`, as `/boss tower --answers` does.
   - **切到 …** focuses the raiser's Herdr tab and writes nothing.
   - **返回** goes back to the list.
3. **Refusals.** A press the server refuses (pressed elsewhere, gone) shows the server's reason, and the list is read again. A session with no screen (`!ctx.hasUI`) is refused, as `/boss memory` writes are.

**Rules for every dialog of the command.**

- It is drawn with `terminalOnlyOpts()`: the GUI never gets a relayed select for a menu the boss opened at a keyboard.
- It runs under the boss mark (`asBoss`, which `boss.ts` already wraps).
- The whole flow runs inside the here mark (`createHereMark`). A paired device's key pad cannot drive the picker; a phone presses its own card in the GUI. A pane that cannot be marked refuses the command, as the link commands do.

**Auto mode.**

- Parked cards are listed and pressable, since the boss is evidently at a keyboard.
- **開始輸入** is left out while `auto.on`, with the line `自動模式開著時不能開始輸入密鑰：先 /boss auto off。` / `Start entering is off while auto mode is on: /boss auto off first.` The server refuses it anyway (`waitpress.ts:138`).

`boss.ts` gains the `wait` completions and description. `memorycmd.ts` exports its card words and `tidy` for reuse, and its behavior does not change.

### 3. The standing pane

#### 3a. The stand-in prompt (no run)

- **The block.** Under the state line the prompt draws `等你處理（2）` / `waits for you (2)` and one line per digest card: the tag, `do`, and the raiser, with `已暫放` when parked. It shows at most 5 cards, then `還有 3 張：/wait`. The block is printed again only when the digest changes, the same way a state change is printed above the line being typed. It makes no bell. The hints gain a row: `/wait 處理等你的卡片` / `/wait press a wait card`.
- **`/wait`** (and `/boss wait`, for habit) enters pick mode, which takes the same steps as §2 as numbered lines:
  - The prompt becomes `等待 ❯` / `wait ❯`.
  - A number picks a card; then a number picks an act.
  - 略過 asks a reason line, then `確定略過？(y/N)`.
  - 回覆塔台 takes the next line as the reply.
  - An empty line goes back one step, and back out of pick mode at the list.
  - Ctrl+C and Ctrl+D keep their meaning (leave the pane).
  - The prompt reads the whole card with `tower-memory { op: "read" }` and presses with `tower-memory { op: "press" }`. Both are token-less requests with the state folder's secret, as its posts are.
- **Which cards.** The list shows this tower's cards first, then the rest (Q2).
- **Only typed keys press.** The prompt's existing input groups (`prompt.ts`) decide:
  - In pick mode, a paste (a bracketed paste, or a group of more than one line) is no pick. Pick mode ends, nothing is pressed or posted, and the prompt says `貼上的文字不算選擇，沒有按下任何東西` / `a paste is not a pick; nothing was pressed`.
  - Digits typed in pick mode are never posted as a boss event. That includes the leave path (below), which today posts what is on the line.
- **A run starts.** When the server tells the prompt to leave (a wake, perhaps the one a press just caused), pick mode is dropped. What is on its line is discarded, not posted, and the prompt prints `塔台醒了，到執行中的窗格用 /boss wait 處理`. A press already sent is answered first: `waitpress.ts` queues the event last and answers at once, and the wake waits 1 s.
- **The here mark.** The prompt opens it (`gui-lan-face` with its pane) for the whole of pick mode and renews it as `heremark.ts` does. A mark that cannot be opened refuses pick mode.
- **Auto mode.** 開始輸入 is not offered while the digest says `auto`.
- **No typing change.** The server types into the pane exactly as now. `typegate.ts` and its table do not change: this is the prompt's own drawing and input (AGENTS.md, Design).

#### 3b. A run's pi in the standing pane (local, head, hand)

- **The one exception.** `/boss wait` is the only `/boss` subcommand a run takes. `boss.ts:80` hands `wait` to `runMode.waits(args, ctx)`, and every other subcommand stays refused. An ally run refuses it too: the boss is not its sender.
- **Same flow, run's code.** `runmode.ts` runs the §2 flow (`waitcmd.ts`) with the run's token-less `ask`, the kind `confirmAuto` uses. The run token is never attached, and `tower-memory` stays refused to it.
- **The widget.** A widget above the editor (`ctx.ui.setWidget`) shows the digest from `run-poll` (the same lines as 3a) and the hint `/boss wait`. A widget is screen only and never enters the model's context.
- **Why a model cannot press.** Three layers hold it off:
  - The press code is reachable only from a typed slash command. Events arrive as messages, never as input, and the run registers no tool that presses (`REGISTERED`, `HEAD_REGISTERED` unchanged; a test asserts no tool reaches `press`).
  - Even if something dispatched the command (another extension's `sendUserMessage(…, { expandPromptTemplates: true })`), the selects are terminal-only under the here mark: only this computer's keyboard answers them.
  - The model sees neither the dialogs nor the widget.
- **What remains** is today's residual. A same-user process with a shell (a main's `bash`) can `herdr pane send-text` into any pane. It could already type `/boss memory done W3` into a boss's pi, or a boss message into the stand-in. The press log names the door (below), so such a press is visible.

The press's log line gains `via: "pi" | "prompt" | "run-pane" | "gui"`, never the text.

### 4. The GUI card on the question panel

**One component.** `ask.ts`'s view parts move to `gui/askview.ts`: the option row (`button.ask-opt`, a bold title, small lines), the radiogroup, the `.ask-acts` row, the `.ask-note` status line, and `askkeys.ts`'s wiring (arrows, then Enter goes to Send). `mountAsk` keeps its answer lifecycle on top of them. The wait card's lifecycle stays its own (`waitcard.ts`, `waitcardmodel.ts`, `waitActions`), drawn from the same parts:

| Wait card part | Panel part |
|---|---|
| tag, raised by, age, parked label | `.ask-head` |
| what you do (choice: the question) | `.ask-q` |
| what happened, where (URL text and **開啟連結**, command block and **複製指令**), after that | `.ask-ctx`, labelled parts as now |
| the acts that end or advance the wait: 我做完了; each option (`then` small); 開始輸入, then 我輸入好了; 請塔台重寫成卡片; **略過**; **回覆塔台** | `.ask-opts` radiogroup of `button.ask-opt` |
| 略過's tells line and reason box; 回覆塔台's text box | revealed under its picked row, like a question's own-words box (`.ask-own`) |
| **送出 / Send** | `.ask-send` |
| 打開 \<raiser\>, 開啟塔台對話, 稍後 (dock) | `cmp-link`s, and the dialog footer as now |
| sending, pressed, refused, stale, ended, step 2 of a secret | `.ask-note` with its tones |

- **Every press is pick, then Send** (Q1). That is the confirm card's own behavior.
  - 略過 needs no confirm of its own: picking it shows `略過會告訴塔台和 <raiser> 你不做這件事` and the reason box, and Send confirms. WC-D1 is kept: two taps, an optional reason, and the card struck for a day.
  - Nothing is preselected, so no single stray tap presses.
- **Folded rows** (tower card, comms, head rows) keep one line (tag, `do`, raiser) with no inline press. A tap unfolds the panel.
- **Parked** (auto mode §7). 5b's mark (`wait_parked`, `已暫放，等你回來` / `Parked for your return`) moves into `.ask-head` in all four views, and the card's acts stay. 5b's silence and dock-queue rules are kept as they are. 5b's `wc_secret_parked` line goes in `.ask-note` in place of 開始輸入.
- **Themes.** Each view's existing `.ask` rules apply. The `.wait-card .wc-*` look rules go, except the part labels, the URL and command block, and the clamp:
  - **Standard and Geek:** no new rules beyond the removals.
  - **Raven:** add `.tcard .ask` and `.tower-notices .ask` to the ornament exclusions at `raven.css:409-410`, so a card nested in the tower card wears no second rule or ticks.
  - **Zen:** `zen.css`'s `.ask` rules replace its `.wait-card` block. Zen's Enter goes to the first option and then to Send.
- **Phone (≤ 640 px).** Every `.ask-opt`, `.ask-send`, and `cmp-link` of a wait card is at least 44 px tall with 8 px between targets in each view. `tests/phone-targets.test.ts` gains the selectors.
- **Words that name the tower follow the wait's tower** (Q3). A head card uses `_head` twins: en `the head tower`, zh-TW 主塔台, and Raven zh-TW 鴉閣. A workspace card stays 塔台, or 管家 in Raven. The twins are for `wc_tag_legacy`, `wc_raised_self`, `wc_p_words`, `wc_b_restate`, `wc_b_reply`, `wc_skip_tells`, `wc_skip_tells_tower`, `wc_pressed_restate`, `wc_told_*`, `wc_ended`, and `wc_ended_plain`. Raven English keeps the base messages. pi and the stand-in prompt are no theme: they use the server's locale words (塔台 / 主塔台).

### 5. Auto mode, all in one place

| Where | While auto mode is on |
|---|---|
| `boss-waits`, digests | carry `auto` and each card's `parked` |
| `/boss wait`, pick mode, run pane | parked cards listed with 已暫放 and pressable; 開始輸入 not offered, with the line; the server still refuses it (`waitpress.ts:138`) |
| dialogs of `/boss wait` | under the boss mark and terminal-only: the guard does not answer them as Escape, and the transition's cancel skips them (auto mode §3, §5) |
| a press | still a `press: true` event, so it never counts as the boss's words for `boss_auto` (AM2-F001), from any door |
| the stand-in and the widget | draw parked cards; no bell, no sound (D8) |
| GUI card | 5b's parked mark in `.ask-head` and its secret line in `.ask-note`; 5b's silence unchanged |
| `/boss auto off`'s return list | its hint reads `/boss wait (or /boss memory done\|choose\|decline W<n>) acts on one:` (`autotower.ts:102`) |

## Security

- **No new door for a run.** `tower-memory` and `boss-waits` stay refused to every run token. A run's pi presses only through its own code, from a typed command, in terminal-only dialogs under the here mark (§3b).
- **Secrets.** Unchanged:
  - The secret's first step is taken at a keyboard of this computer: a pi or the stand-in, under the here mark. The GUI's paired-device refusal stays.
  - The value goes through `secret_drop` in the raiser's terminal only. No dialog of this spec takes a value, and a reason is checked for secret shape by the server as now.
- **Text from the model in a terminal.** Card fields are cleaned at storage and again at every reader (`boss-waits`, the digest, the prompt's print). The stand-in writes raw to a terminal, so an ESC left in a field could move the cursor or fake a line. That is why the prompt cleans again.
  - Act numbers and labels are drawn by code in their own column, never inside a field.
  - URLs and commands are shown as text: nothing is opened, fetched, or run.

## Tasks

Red first: each task writes its tests, sees them fail on f807db69 or its prerequisite, then makes them pass. Run `npm run check` and `npm test` before hand-over. Tasks 1 to 4 are one shared contract (control commands, the run boundary, the prompt's input), so a fresh-context `reviewer` reads them together, and only P0 and P1 block. Task 5 gets a visual check and the boss's screenshots.

| # | Task | Files | Tests (red first) | Depends on |
|---|---|---|---|---|
| 1 | `boss-waits` and the poll digests | new `src/server/waitlist.ts`; `src/server/main.ts`, `towers.ts`, `standing.ts` (prompt-poll), `runs.ts` (run-poll); `src/towerprompt/source.ts` | new `tests/wait-list.test.ts`. **Lists:** head first then the towers, each once; open and answered only; `-w` filter; a parked flag and `auto`; an ESC in `do` removed. **Refusals:** a run token gets `boss-waits` refused. **Digests:** `prompt-poll` carries the pane's own tower's digest cut to 120; `run-poll` carries it for local and head runs and none for ally runs. | none |
| 2 | `/boss wait` in any pi | new `src/waitcmd.ts`; `src/boss.ts` (route, completions, description); `src/memorycmd.ts` (export words, `tidy`); `src/server/autotower.ts` (return-list hint) | new `tests/wait-command.test.ts`. **Acts:** the kind × state table of acts; choose sends the option's index. **Decline:** asks a reason, then confirm; a No sends nothing. **Other acts:** reply goes as `tower-event` with `answers`; a refusal is shown and the list read again. **Auto mode:** 開始輸入 is absent with the line. **Dialogs:** every one carries `terminalOnlyOpts`, runs under `asBoss`, and inside the here mark; a refused mark asks nothing. **No screen:** refused. **Unchanged:** `tests/memory-command.test.ts` passes as is; `tests/auto-towers.test.ts` gets the new hint. | 1 |
| 3 | The run pane: `/boss wait` and the widget | `src/boss.ts` (the one exception), `src/runmode.ts` (`waits`, widget, token-less press) | new `tests/wait-run-pane.test.ts`. **The exception:** a local, head, and hand run press through a token-less `tower-memory` (the run token is never sent), while `/boss memory` and `/boss tower` in a run stay refused, and an ally run refuses `wait`. **No model press:** an event whose text is `/boss wait` runs no command; the run's tools reach no `press`; the bridge publishes no relayed dialog for the picker. **Widget:** follows the poll digest and clears when it is empty. **Auto mode:** a press event on a card that holds 我起床了 does not end it. | 2 |
| 4 | The stand-in prompt: the block and pick mode | `src/towerprompt/prompt.ts`, `messages.ts`, `look.ts`, `serversource.ts` (read, press, reply, face mark) | new `tests/tower-prompt-waits.test.ts` (fake source and clock). **Block:** printed on change only, 5 then `還有`; ASCII and zh-TW words. **Pick mode:** `/wait` and `/boss wait` enter it; numbers pick a card, then an act. **Decline:** a reason line, then `y`. **Pastes:** a paste ends pick mode with no post and no press. **Leaving:** a leave in pick mode posts no digits as a boss event; a press's answer is printed before the leave. **Text and marks:** an ESC in card text is not written; a refused face mark refuses pick mode. **Auto mode:** no 開始輸入. **Existing tests:** `tests/tower-prompt.test.ts` gets the new hint and the unknown-command words. | 1 |
| 5 | The GUI card on the question panel (after `feat/auto-mode-gui` merges: both rework `waitcard.ts`, `waitcardmodel.ts`, `style.css`, and the messages) | new `gui/askview.ts`; `gui/ask.ts`, `waitcard.ts`, `waitcardmodel.ts`, `waitpanel.ts`, `layer.ts`, `zen.ts`, `towernotes.ts`, `style.css`, `zen.css`, `themes/raven/raven.css`, `themes/raven/sentences.ts`, `messages/en.json`, `messages/zh-TW.json`, `demo-waits.ts` (a head card and a parked card) | **`tests/wait-card-gui.test.ts`:** the model's table now gives option rows per kind and state; a pick alone posts nothing, and Send presses; 略過 picked shows the tells line and reason box, and Send declines; reply picked shows the box, and Send goes to the tower's input with `answers`; a parked card shows the label in four views and keeps its acts; a folded row has no press. **Words:** `tests/raven-words.test.ts`: a head card reads 鴉閣, a workspace card 管家, and no Raven zh-TW wait word holds 塔台. **Phone:** `tests/phone-targets.test.ts`: 44 px per view. **Updated:** `tests/tower-wait-dialog.test.ts`, `wait-panel-buttons.test.ts`, `ask.test.ts` (unchanged behavior after the extraction), `imports.test.ts` (caps measured). **Screenshots** for the boss in `~/.local/share/sbd-review/wait-cards-tui/`: Standard, Geek, Raven, Zen, desktop and phone. | the merge of `feat/auto-mode-gui` (5b) |
| 6 | Docs | `docs/how-it-works.md`, `README.md`, `docs/specs/2026-11-07-wait-cards.md`, `docs/specs/2026-11-09-auto-mode.md`, release note | **how-it-works:** the Waits paragraph, The standing pane, and "takes no /boss command" except `wait`. **README:** `/boss wait`. **Spec amendments:** both specs get a short amendment pointing here. | 1 to 5 |

Workspaces: tasks 1 to 4 run in sequence on one branch (they share `waitlist.ts` and `waitcmd.ts`). Task 5 runs in its own worktree from the `main` commit that merged 5b, since it touches only `gui/` and its tests.

## Decisions (boss, 2026-11-10: every recommendation taken)

| # | Question | Decision (the recommendation) |
|---|---|---|
| Q1 | In the GUI, every press becomes pick, then Send. An action card goes from one tap to two, and a folded row loses its inline button (a tap unfolds it). | **Yes.** It is exactly the alert confirm card's behavior, it carries WC-D1's two-tap skip with no special confirm, and no stray tap on a phone presses. |
| Q2 | Which cards a standing pane shows and lists. | **The block and the widget show the pane's own tower** (the head pane: the head's own). **`/wait` and `/boss wait` list all, own tower first.** The always-on lines stay short, and the picker is the same everywhere. |
| Q3 | Head cards say 主塔台, and 鴉閣 in Raven, through `_head` twin messages, rather than a `{tower}` noun input. | **Twins.** English capitalizes `Head tower` as a noun, so an input reads badly in sentences. Twins are what `raven-words.test.ts` checks one by one. |
| Q4 | The here mark over the whole picker (pi, stand-in, run pane), or only over 開始輸入. | **The whole picker.** It is one rule, and a phone presses on its own card. The cost: a phone's key pad cannot drive `/boss wait` in a pane. |

## Acceptance

- [ ] `/boss wait` in a main's pi lists every open card across towers and the head, presses each act without a `W<n>` typed, and `/boss memory …` behaves as before.
- [ ] In a tower's stand-in prompt and in a live run's pane, the boss sees the open cards and presses them with typed keys. A paste, an event, and the run's model press nothing.
- [ ] `tower-memory` and `boss-waits` stay refused to run tokens.
- [ ] The secret's first step is taken only at this computer's keyboard and is unavailable under auto mode.
- [ ] In Standard, Geek, Raven, and Zen, a wait card is the question panel: pick, then Send. A parked card shows 已暫放，等你回來. Phone targets are 44 px. A head card says 主塔台, or 鴉閣 in Raven.
