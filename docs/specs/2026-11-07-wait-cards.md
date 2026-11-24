# Wait cards: a tower's wait for the boss as a card with fields (2026-11-07, todo #126)

The boss, about a tower wait in the GUI: 「每次出來這個我都不知道要處理什麼」「塔臺的這種 waiting 完全沒辦法互動，根本不知道要處理什麼」「我只能先略過，覺得莫名其妙」.

The case that prompted it (MP Center tower, dock dialog): 「提問 · 等你決定: Re-auth fonstar-staging in Tailscale (node key expired ~10:30) or disable key expiry; MP-3946 print deploy there is done but unreachable.」 with **去處理** (unfolds an answer box), **開啟塔台對話**, **稍後**, **略過**.

Why it failed:

1. The text is the run's own words in agent-terse English: `prompts/tower.md` and `prompts/tower-run.md` tell a tower to write terse to agents, and nothing says the boss is not one.
2. It does not say which main raised it, where to do the thing (a URL, a command), or what happens after.
3. There is no "done" path. **去處理** opens an answer box, which fits a question; for a task the boss can only type "done" by hand. **略過** drops the wait without telling the tower or the main.
4. The tool takes free text (`tower_memory add kind wait`, `text` ≤ 200, "your own words", `src/memorytool.ts`), so nothing checks any of this.

**Boss decision (verbatim choice): 「改成有欄位、可以操作的卡片」.** The tower fills fields: what happened, what the boss does, where (URL or command), what happens after, and which main raised it (a session id taken from the event, not typed). They are written in plain words, in sb's own locale (**Language**; the boss, 11-07: 「不需要吧，有可能是英文，而且我的sb是雙語言的啊..........明明就有 i18n」, so sb does not judge the language of the words). sb checks the fields and refuses the wait back to the tower otherwise. A card's kind comes from its type: **action** (我做完了 / 打開提出的 main), **choice** (one button per option), **secret** (the `secret_drop` flow). A press notifies the tower and the raising main, by session id.

This record changes **Tower memory → Waits** of `2026-10-26-sb-backend.md` (the `for: "boss"` bullet), the wait panel of `2026-11-01-zen-view.md` (a wait item), and the wait rows of `2026-11-06-head-page-minimal.md`. Waits `for: "agent"` are unchanged.

## Scope

- In: the `tower_memory` schema for a boss wait and its refusals; the stored entry and how existing free-text waits read; the memory route's new `press` op and `/boss memory`'s commands for it; the notices a press sends; the card in every place a boss wait is drawn (the dock dialog in Standard and Geek, the tower card's row, the tower's comms, Zen's card, the head page's rows) and its phone layout; what 稍後 and 略過 do; the prompts; the snapshot's size; tests, demo, and docs.
- Out: waits `for: "agent"`; the alert queue, the HUD, Zen's order and cue (a wait card is the same item it was); entering a secret from a page, which stays terminal-only (SB-F001); sb running a command; judging whether the words are good. sb checks shape, length, URL form, command form, secret shape, and `from`; it never judges or refuses on language. Plainness and the language are the prompt's job.

## Terms

- **Wait card**: an open or answered wait `for: "boss"` that has a `card`.
- **Legacy wait**: a wait `for: "boss"` stored before this record (free `text`, no `card`).
- **Raiser**: the session whose event made the tower record the wait (a main, a member, another tower, or for the head tower a workspace tower). It is recorded by session id. **Self** means the tower raised the wait itself, from a timer, a notice, or a boss message.
- **Press**: the boss's button on a card (`done`, `choose`, `secret`, `decline`, `restate`), sent to the memory route.
- **sb locale**: `zh-TW` or `en`, the sb server's own locale (`localeOf(env)`, `src/towerprompt/messages.ts:9`; **Language**).

## The tool

`tower_memory { op: "add", kind: "wait", for: "boss", … }` takes these fields. `text` is refused for a boss wait, with the words "a wait for the boss takes the card fields (happened, do, …), not text". A wait `for: "agent"` keeps `text`, `on`, and `due` as today.

| Field | Type | Required | Cap | What it is |
|---|---|---|---|---|
| `type` | `"action"` \| `"choice"` \| `"secret"` | yes | | Picks the card's buttons. |
| `happened` | string | yes | 160 | What happened, in one or two plain sentences. |
| `do` | string | yes | 160 | What the boss does, as an instruction to a person. For a `choice`, the question. For a `secret`, which secret and how to get it. |
| `url` | string | action: `url` or `command`; secret: optional; choice: optional | 300 | Where to do it. Only `http:` or `https:`, with no userinfo (**Security**). |
| `command` | string | as above | 300, at most 4 lines | A command the boss runs themselves. Shown with a copy button and never run (**Commands**). |
| `after` | string | action, secret: yes; choice: no (each option says it) | 160 | What happens once the boss has done it: what the tower or the main does next. |
| `options` | `{ label, then }[]` | choice: 2 to 4; others: refused | label 24, then 120 | One button per option. `then` says what that pick leads to. Labels are unique. |
| `secret` | `{ name }` | secret: yes; others: refused | name 60 | What the secret is (「fonstar-staging 的 Tailscale auth key」), never its value. |
| `from` | string | yes, unless `restates` names a wait that has one | 200 | The raiser's session id as the `[intercom from <name> (<id>)]` line shows it, or `"self"`. |
| `restates` | `"W<n>"` | no | | An open or answered boss wait (legacy or card) that this one replaces. The old one is dropped in the same write, and its `from` is carried when `from` is not given. |
| `due` | number | no | 5 to 10080 | Unchanged. |

**`from` is checked against what the run received, not taken from the model.** The server accepts a session id only when it is the `from.id` of an intercom event this run took (a new `runs.intercomEvents(token)`, alongside `bossEvents`). That is the id the code wrote into the `[intercom from …]` marker (`eventText`, `src/runmode.ts:77`), taken from the broker, not from the sender's header. At the write, the server reads the raiser's name, role, workspace label, and tab from the net (`reach.read()`, by id; never by name, since a subagent shows on intercom as `subagent-chat-<id>`, todo #49) and stores them. A raiser that has left the net since the event is still stored, with the event's name, and marked `gone`. `self` stores no raiser. A `secret` wait refuses `self`: only a session can call `secret_drop`, and a tower run cannot (it never asks the boss).

**Refusals.** One tool error lists every field that fails, so a single retry can fix them all. Nothing is kept. The words are English, since a run reads them:

```
Not recorded: a wait for the boss is a card they act on, and 3 fields need a fix (nothing was kept; call tower_memory again with every field).
- happened: missing. Say what happened in one or two plain sentences.
- do: says the same as happened: say what the boss does.
- url: "javascript:…" is not an http(s) address. Give the page's https address, or a command instead.
```

| Check | Refusal line (after `- <field>: `) |
|---|---|
| missing or empty | `missing. <what the field is, from the table>` |
| over the cap | `too long: at most <n> characters` |
| secret-shaped text in any field (`SECRET` and `BASE64_RUN` of `src/boardauto.ts`, exported for this; narrowed, see **Secret shape** under the choices) | `looks like a secret or a key. A wait never carries one: name it in secret.name and use type secret` |
| `url` not `http(s)`, has userinfo, does not parse | `"<first 40 chars>" is not an http(s) address …` |
| `command` with a control character other than a line break, or more than 4 lines | `a command is plain text of at most 4 lines` |
| `do` equals `happened` | `says the same as happened: say what the boss does` |
| `options` on a non-choice, fewer than 2, more than 4, duplicate labels | `…` (the rule in words) |
| `from` not a sender of this run's events | `<id> sent you nothing in this run. Name the session id from the [intercom from …] line of the message that raised it, or "self" when you raised it yourself` |
| `restates` not an open or answered boss wait | `No such wait W<n> to restate` |
| the 12-wait cap | unchanged |

**Language.** The card's words follow sb's own locale, not a guess from the boss's messages (boss, 11-07). sb is bilingual: the GUI has `en` and `zh-TW` (Paraglide, `gui/i18n.ts`), and the server's text follows `localeOf(env)` (`LC_ALL`, `LC_MESSAGES`, `LANG`, else the system language; zh-TW, zh-HK, zh-MO, or zh-Hant is `zh-TW`). That is the rule that already names the head tower 主塔台 (`src/server/head.ts:31`) and picks the tower prompt's and `/boss memory`'s words. The GUI's choice is per device (the language menu kept in the page's local storage, else the browser's languages) and never reaches the server, so the server's locale is the one sb can name to a run.

- The brief's `tower_memory` line in its tools block (never cut, The brief in sb-backend) ends with one code-written sentence: `Write a wait for the boss in Traditional Chinese (sb's locale is zh-TW).` (or `in English (sb's locale is en)`), so it is there even when the memory is empty (the tools block's 900-character cap still holds with it: a test). `MEMORY_DESCRIPTION` says the same in general ("in the language your brief names").
- The stored card keeps `lang`, the locale the brief named when it was written, for display only (the `lang` attribute of the card's text, so a screen reader and the font pick the right script).
- sb does not refuse a card on language: no detection, no threshold, no script list. A card written in the other language is accepted as it is, as the boss asked (「有可能是英文」).
- A device whose page is set to the other language shows the card's labels and buttons in its own language and the tower's fields as written.

The tool's description (`MEMORY_DESCRIPTION`) and its schema descriptions say all of this in short. The schema gives every field its own `description`, so a model sees what each one is for.

## The stored entry

`memory.json` stays `v: 1`. A boss wait gains `card` and, after a press, `press`:

```json
{ "id": "W9", "kind": "wait", "for": "boss", "state": "open", "by": "run", "via": "run", "run": "c0ffee12…", "at": "2026-11-07T10:41:00Z",
  "text": "到 Tailscale 管理頁重新授權 fonstar-staging，或把它的金鑰設成不會過期。",
  "card": { "type": "action", "lang": "zh-TW",
    "happened": "fonstar-staging 這台機器的 Tailscale 登入金鑰約 10:30 過期，它現在離線。MP-3946 的列印功能已經部署到那台，但連不上，沒辦法測。",
    "do": "到 Tailscale 管理頁重新授權 fonstar-staging，或把它的金鑰設成不會過期。",
    "url": "https://login.tailscale.com/admin/machines",
    "after": "機器連回來後，塔台會請 MP-3946 的 main 驗證列印功能。",
    "from": { "id": "4f1c…", "name": "mp3946-print", "role": "main", "workspace": "MP Center", "tab": "MP-3946" } },
  "press": { "act": "done", "at": "2026-11-07T10:58:00Z", "main": { "status": "delivered", "at": "2026-11-07T10:58:01Z" } } }
```

- `text` is set to `do`, so every reader of `text` keeps working: the brief's row, `bossWaits[].text`, the system notification, Zen's head strip, `/boss memory`.
- `card.from` is absent for `self`. `gone: true` is set when the raiser was not live at the write.
- `press` is `{ act, option?, reason?, at, main?: { status: "delivered" | "queued" | "gone" | "failed", at } }`. `option` is the index of the option picked. `secretAsked` (an ISO time) is set by the first step of a secret card (below).
- `isEntry` checks `card` by its own shape. An entry whose `card` fails the check reads as a legacy wait (the card is dropped on read, nothing is written). The whole file is not made unreadable, so a newer build's card never locks an older file.

**Legacy waits.** A wait `for: "boss"` without `card` is read as it is. No migration writes anything. It shows as a legacy card (below), and its brief row ends with `(old free-text wait: record it again as a card with restates: "W<n>")`. The next run that sees it restates it, and the old one goes in that write.

**The brief and `read`.** A card wait's row is `- [W9] for boss (action, from mp3946-print): <do>`, followed by `(due …)` and `(open …)` as now. After a press it reads `pressed 我做完了 at 10:58; check: <after>`, `chose "<label>" at …: <then>`, or `ready to enter <secret.name> at …; <name> was told to call secret_drop`. A declined wait is `resolved` and so leaves the brief, as now. The row is capped at 360 characters.

## The press

A new op on the memory route (`memoryRequest`, `src/server/towermemory.ts`): `{ op: "press", id, act, option?, reason? }`. It takes no `rev`, since a wait's id is never reused, like `answer` and `drop`. Its doors are the boss's only: the GUI's `POST tower/<ws>/memory` (and `head/memory`) and the control socket's `tower-memory`. `rungate.ts` already refuses both to every run token, so a run cannot press its own card.

| `act` | Card | Allowed when | Memory | The tower's event | The raiser's notice |
|---|---|---|---|---|---|
| `done` | action; secret after `secret` | open or answered by a reply with no press (a secret card: `secretAsked` set) | `answered`, `press` | `The boss pressed "我做完了" on wait W9 (<do>). Check it, then resolve W9: <after>` | `The boss did what wait W9 asked: <do>` |
| `choose` | choice | open or answered by a reply with no press | `answered`, `press.option` | `The boss chose "<label>" on wait W9 (<do>): <then>. Act on it, then resolve W9.` | `The boss chose "<label>" on wait W9: <then>` |
| `secret` | secret | open or answered by a reply with no press, not `secretAsked` | `secretAsked` (still open) | `The boss is ready to enter <secret.name> for wait W9; <raiser> was told to call secret_drop now.` | `The boss is at this computer to enter <secret.name> (wait W9): call secret_drop now for it, in this session. Tell the tower with call_tower when it is stored.` |
| `decline` | every card, legacy too | open or answered | `resolved`, outcome `declined by the boss[: <reason>]`, kept 24 h | `The boss declined wait W9 (<do>)[: "<reason>"]. Do not ask again unless something changed; tell the raiser what happens instead.` | `The boss will not do what wait W9 asked (<do>)[: "<reason>"]. The tower decides what comes next.` |
| `restate` | legacy | open | `answered` | `The boss asks you to record wait W9 again as a card (tower_memory add kind wait with restates: "W9"); its old text: <text>` | none (a legacy wait has no raiser) |

- A **reply in the card's box** (回覆塔台) is `answer`, not a press: it marks the wait `answered` with no `press`, the card stays pressable, and the brief's row reads `answered by the boss at <hh:mm>, check their message: <do>` until a press changes it.
- The route refuses a `value` (400): a press carries none.
- `reason` is at most 120 characters and goes through the same secret-shape check, which refuses it with "a reason never carries a secret".
- A second press on an answered wait is refused, 409 `refused` (`W9 was pressed already: 我做完了 at 10:58`), except `decline`. A wait that is gone is `No such wait W9` as now.
- **Order.** The server sends the raiser's notice first, waits for the broker's answer (at most 5 s), records `press.main`, and only then queues the tower's event. The event therefore tells the tower whether the raiser got the notice. One of these is appended: `<name> got it.`, `<name> was not reached (<status>): tell it yourself, or tell its owner if it is gone.`, or for `self` nothing. There is no retry loop: the tower owns a notice that did not arrive, as it owns any `blocked`.
- **The tower's event** is a boss event through `runs.boss(workspace, text, "the boss (wait card)", { press: true })`. It wakes a run as any boss message does, and the comms show it as the boss's line (the session file holds it as the boss's message). `press: true` marks it as a press's text (the comms draw it as the boss's button, 「你按了我做完了」, not as typed words).
- **The raiser's notice** is one intercom message from the tower's identity to `from.id`, resolved by id in the broker's live sessions and never by name (todo #49). The header is code-written, with a new header kind `wait_card` (`src/header.ts` `Kind`), `reply=none`, and `why` absent, and a field `wait=W9`. A raiser not in the live list is `gone`: nothing is sent and the tower's event says so. The head's waits notify a workspace tower the same way (its identity is a session id).
- **Logs** name the op, the act, the id, and the delivery status, never the text (as every memory line).

**`/boss memory`** gets the same acts, so pi stays the first interface (D23): `/boss memory done W9`, `choose W9 <n>`, `decline W9 [reason]`, `restate W9`. There is no `secret` command, because in pi the boss is at the terminal already: `done` on a secret card whose first step was not taken sends that step (`secret`, which tells the raiser to call `secret_drop`) and then `done`, so `done` closes it. `edit` of a card wait is refused (a card is recorded again by the tower with `restate`; the boss may answer, decline or drop it). These are writes, so they are refused without a screen, as every write is.

## The card in the GUI

One component, `gui/waitcard.ts`, draws a wait for the boss everywhere one is drawn. Its rules (which parts, which buttons, which state, which words) are in a pure `gui/waitcardmodel.ts` with a table test. `gui/waitpanel.ts` keeps its answer box as the card's **回覆塔台** fold and loses its own buttons. Standard and Geek change only where a wait is drawn: the dialog shell, the queue, the HUD, and the title stay as they are. The dialog's badge is the card's own kind word (Needs you / Your choice / Needs a secret / Older wait) instead of QUESTION, since the card under it says the same word (GUI review GR-F007); the card's own tag line is then hidden in the dialog.

### Parts

| Part | zh-TW / en | Source |
|---|---|---|
| Tag | 需要你處理 / Needs you · 請你選擇 / Your choice · 需要你輸入密鑰 / Needs a secret · 塔台的舊提問 / Older wait | `card.type`, or legacy |
| Raised by | 由 mp3946-print 提出 · MP Center › MP-3946 · 12 分前 / Raised by … · 12m ago; self: 塔台自己提出 / Raised by the tower; gone: 「（已離開）」 | `card.from`, `at` |
| What happened | 發生什麼事 / What happened | `happened` |
| What you do | 你要做的事 / What you do (choice: 要你決定 / Your call) | `do` |
| Where | 在哪裡 / Where: the URL as plain text with **開啟連結 / Open link**, or the command in a monospace block with **複製指令 / Copy** | `url`, `command` |
| After that | 做完之後 / After that | `after` |
| Legacy | 塔台的原話 / The tower's words | `text` |

Each text part is clamped to three lines with a "更多 / More" toggle. In the dock dialog every part shows whole. A part with no value is left out.

### Buttons by kind and state

| Kind | Open | After a press |
|---|---|---|
| action | **我做完了 / I'm done** (primary) · **打開 mp3946-print / Open mp3946-print** (not for self or gone) | 「你按了我做完了・已通知塔台和 mp3946-print，等塔台確認」 |
| choice | one button per option: the label in bold, `then` under it in small text, all one width, stacked · **打開 …** as a quiet link | 「你選了：<label>・已通知塔台和 …」. The picked option stays marked and the rest are off. |
| secret | **開始輸入 / Start entering** (primary, this computer's page only) · **打開 …**. A paired device shows 「請到電腦上輸入」 / "Enter it at the computer" in place of the primary, with no start button (WC-D4); the rest of the card and 稍後, 略過, 回覆塔台 stay. | Step 2: 「已請 mp3946-print 開啟輸入框。到電腦上 Herdr 的 MP-3946 分頁輸入」; once the raiser's unit has a `secret_drop` dialog pending (the snapshot's `pending.tool`), 「輸入框已開啟，請到終端機輸入」. **我輸入好了 / I've entered it** (primary, sends `done`). |
| legacy | **請塔台重寫成卡片 / Ask the tower to rewrite it** (primary) | 「已請塔台重寫」 |

Every kind also has, in this order after the primary: **回覆塔台 / Reply to the tower** (a quiet link that unfolds today's answer box; the words go to the tower's `input` with `answers: W9`, as now), **略過 / Skip** (below), and **稍後 / Later** where the host has it. The tower-comms link (**開啟塔台對話**) moves to the dialog's footer as its quiet last item, as now. On the tower card and in the comms the card has no comms link (`here`).

**States** (from the model): `open`; `sending` (buttons off, the pressed one says 「送出中…」); `pressed` (the line above; buttons off except 略過, 回覆塔台, and 打開 <raiser>, which only navigates); `refused` (the server's reason under the buttons, as `tnote-fail`; buttons on again); `stale` (the stream is down: buttons off, 「連線中斷，暫時不能按」); `ended` (resolved by the tower: 「塔台已確認：<outcome>」, struck, until the snapshot drops it). In tower notices, an accepted press folds the row to one status line: the choice and that it awaits confirmation. An answered snapshot draws the same folded row after a reload; resolving the wait removes it. Starting secret entry does not fold the row. The flash under the tower card's rows (`towernotes.ts` `flash`) says the press's line for 4 s, as it says a dismissal now.

**Where it is drawn:**

- **Dock dialog** (`waitDialog`, `gui/layer.ts:115`): the whole card in `.ask-root`. The footer is 開啟塔台對話 · 稍後 · 略過. `.intel` stays hidden. The dialog opens with the focus on the card's primary button (a choice: its first option). It is modal for presses: while a wait's dialog is on top the page behind it (`#work`) is `inert`, so a tap on a row or card under the dialog, or in the strip beside a phone's sheet, never presses another wait (GR-F004); the HUD, Later, and × stay live. Open <raiser> finds the raiser's workspace by its unit key in the newest snapshot, since the head's alert is on the head's base (GR-F001).
- **Tower card row and tower comms** (`gui/towernotes.ts`): the card folded. One line shows the tag, `do`, and the raiser, with the primary button beside it. A tap on the line unfolds the other parts. A row that was unfolded stays unfolded across a redraw, as an answer being typed does now.
- **Zen card** (`gui/zen.ts:162`): the whole card in Zen's skin (`zen-head-*` look, ink palette). The primary takes Enter (`enter()`), and 晚點再說 stays Zen's skip. A press plays the card's outcome (the knock) through `send`, as an answer does. **打開 <raiser>** is there as on the other hosts; its click leaves Zen for the raiser's session, as the companion's session link does (`deps.leave({ route })`).
- **Head page rows**: the folded card, as on a tower card.

### 稍後 and 略過

- **稍後 / Later** is unchanged. It is the dock's "back in the queue" and calls nothing on the server. Zen's 晚點再說 likewise.
- **略過 / Skip** is now the `decline` press. The first tap unfolds, in place, one line 「略過會告訴塔台和 mp3946-print 你不做這件事」, an optional reason box (原因（選填）, 120 characters), and **確定略過 / Skip it** with **取消**, and the focus goes to **確定略過** (not to the optional reason box, which would open a phone's keyboard over the confirm) with the confirm scrolled into view. Only the second tap sends. On a phone that confirm is the protection against a stray tap. The wait becomes `resolved` (struck for 24 h) instead of vanishing. `drop` stays on the memory route for `/boss memory` and old pages but is no longer offered on a card.

### Commands

`command` is shown in a `<pre>` through `textContent`, with its line breaks, wrapped whole (`white-space: pre-wrap`, `overflow-wrap: anywhere`) so that every character is visible on a 390 px phone; a sideways scroll would hide the tail of text the boss copies and runs (GR-F002). **複製指令** copies it with `navigator.clipboard.writeText`. Where that is not allowed (a paired phone on plain `http:` LAN), it selects the text and says 「已選取，請長按複製」. sb never runs it. There is no Run button, no terminal card, and nothing goes to a pane, the key pad, or the server. The card says 「sb 不會替你執行」 under the block.

### Phone (narrow layout, ≤ 640 px)

- The card fills the dock sheet. Parts stack (the label above the value). The raiser line wraps.
- Every button and link is at least 44 px tall with 8 px between targets. The primary is full width. Choice options are full-width rows of at least 44 px, separated by 8 px. 回覆塔台, 略過, and 稍後 share one row that wraps.
- A URL wraps anywhere (`overflow-wrap: anywhere`). **開啟連結** is a 44 px button below it. The command block wraps whole, with **複製指令** below it (copy still takes the command as written).
- The secret card's step 1 has no primary on a paired device (above).
- `tests/wait-card-gui.test.ts` checks the CSS rules for the 44 px targets in the phone layout, as `tests/phone-targets.test.ts` does for other controls (that test also gets the new selectors).

## Security

- **No secret in a wait.** Every field and a decline's `reason` are refused when they are secret-shaped (**Refusals**). The secret card carries the secret's name only. The value is entered by the raiser's `secret_drop` in its terminal, never on a page (SB-F001 stands), and a press carries no value: the route refuses `value` as the answer route does.
- **URLs** are parsed with `new URL`. Only `http:` and `https:` with a host and no userinfo are accepted, up to 300 characters. The card shows the URL in full, as text (`URL.href`, so an IDN host shows in punycode and cannot pose as another host), and the link is an `<a href>` with `target="_blank" rel="noopener noreferrer"`. It opens only on a click. Neither the server nor the page fetches it (no preview, no favicon), and the snapshot carries it only to the boss's own page and paired devices, which already see memory.
- **Text** reaches the DOM through `textContent` only, never as HTML or Markdown. Each field is cleaned as board text is (`clean`) except `command`, which keeps line breaks and loses other controls.
- **The raiser** is the broker's id of an event the run took, never the model's word. The card names it by the name the net gave at the write. A press resolves it again by id. A same-user process that registers under that id still receives the notice: the residual of every pi-intercom identity (sb-backend **Waits**, `for: "agent"`).
- **Doors.** A press is the boss's alone (above). An ally run has no `tower_memory`. Memory reaches no ally brief, board, link envelope, or log text.
- **Size.** See the next section.

## The snapshot

A boss wait that was declined or resolved stays in `bossWaits[]` with `state: "resolved"`, `outcome` and `ended` until the 24 h sweep drops it (WC-D1's struck-through day, and the card's `ended` state); it is not counted in `waits`, raises no alert, and the rows and the Zen strip skip it.

`MemorySummary.bossWaits[]` gains `card` (as stored, `from` as `{ name, role, workspace?, tab?, gone? }` plus the raiser's unit key when the net has it, so **打開 …** links to the session view) and `press`. Every page and paired device gets the whole snapshot on every change, so the cards are bounded as the head's broadcast cards are (`2026-11-07-head-log-cards.md`, **Payload**). Whole cards are sent, newest first across all towers, while their text sum is at most `CARD_TEXTS` = 24,000 UTF-16 units. Any card after that goes as `{ id, text, at, answered?, cut: true }`, and the card reads its entry with the memory route's `read` when it is drawn, unfolded, or opened in the dock. The limit is measured in `tests/wait-cards.test.ts`: 12 waits × 10 towers with every field at its cap.

## Prompts

- `prompts/tower.md`: after the terse line, add: "The boss is not an agent: write a wait for them in plain full sentences, in the language your brief names, no shorthand, a ticket id only beside what it is." (31 words; shortened from 39 in the GUI review, GR-F012.)
- `prompts/tower-run.md`: replace "A wait for the boss reaches them as an alert in the GUI, so write what they have to do in one line they can act on (a token to hand over, a go to give), not a topic." with the rule below and one worked example (the fonstar case, as in **The stored entry**):
  - Record a wait for the boss as a card: `type` (action when they do something, choice when they pick, secret when a session needs a secret from them), `happened`, `do`, `url` or `command` (where, for an action), `after`, `options` (for a choice), `secret.name` (for a secret; never the value), and `from`: the session id in the `[intercom from …]` line of the message that raised it, or `self`.
  - Write every field in the language the brief's Memory section names (sb's locale), as sentences a person who has not followed the work understands: say what a host, a ticket, or a tool is the first time.
  - A refusal lists what to fix. Fix every line and call again.
  - When the boss presses a card you get their message (`The boss pressed …`, `chose …`, `declined …`): act on it, then resolve the wait. A declined wait is over: tell the raiser what happens instead.
  - A legacy wait (`old free-text wait`) is recorded again as a card with `restates`.
  - Do not send the raiser the same news yourself: sb told it, and your event says whether that reached it.
- `prompts/head-run.md`: the same rule in its words ("record a wait for the boss with `tower_memory` as a card, in the language your brief names; `from` is the tower's session id").
- `prompts/main.md`: one line: "A `wait_card` message is the boss's answer to your wait: act on it; it says when to call `secret_drop`." (20 words; the raiser's notice carries the `secret_drop` instruction itself.)
- `MEMORY_DESCRIPTION` and the schema in `src/memorytool.ts` as in **The tool**.

The prompt tests (`tests/prompts.test.ts`) check that these words are there and that `tower-run.md` no longer has the one-line rule.

## Docs

- `2026-10-26-sb-backend.md` **Tower memory**: the sample entry, the cap table (a boss wait's fields), the `for: "boss"` bullet (a pointer to this record), and the memory route's op list (`press`).
- `docs/how-it-works.md`: the wait paragraph (the card, its kinds, 略過 tells, commands are never run).
- `README.md`: one line if it describes waits.

## Tests and tasks

Red first: each task writes its tests, sees them fail on main, then makes them pass. `npm run check` and `npm test` before hand-over. A fresh-context `reviewer` reads tasks 1–3 together and task 5. Both are shared contracts: the tool schema, `memory.json`, the header kind, the snapshot, the prompts, and the GUI contract. Only P0 and P1 findings block.

| # | Task | Files | Tests (red first) | Depends on |
|---|---|---|---|---|
| 1 | Card validation and storage: the field rules, the refusals (all lines at once), secret shape, URL and command rules, `from` against `runs.intercomEvents`, `restates`, the stored `card` with `lang`, the brief's locale line, a legacy entry read as is, a bad `card` read as legacy, the brief and `read` rows | new `src/server/waitcard.ts` (pure checks), `src/server/towermemory.ts`, `src/memorytool.ts`, `src/server/towerbrief.ts` or `towers.ts` (the locale line from `localeOf(env)`), `src/server/runs.ts` (`intercomEvents`), `src/boardauto.ts` (export `SECRET`, `BASE64_RUN`) | `tests/wait-cards.test.ts`: a table of every refusal line; the fonstar card accepted in Chinese and in English under either locale (no language refusal); the brief names `zh-TW` for `LANG=zh_TW.UTF-8` and `en` for `LANG=en_US.UTF-8`; an `sk-…` key and a 40-character mixed run refused in any field; `javascript:`, `https://u:p@h`, and a 301-character URL refused; `from` of another run's event refused; `self` on a secret refused; `restates` drops the old wait in one write; a file with a legacy wait and one with a bad card both read, and nothing is written. Update `tests/server-memory.test.ts`, `tests/server-memory-run.test.ts`, `tests/tower-wait.test.ts`. | none |
| 2 | The press: the `press` op, each act's memory change, the order (the notice, then the event), the `wait_card` header, resolving the raiser by id only, `gone`, `/boss memory` acts, refusals (second press, wrong act for the type, a run token) | `src/server/towermemory.ts`, `src/server/towers.ts` (the sender, through `reach.post` from the tower identity), `src/header.ts`, `src/memorycmd.ts` | `tests/wait-press.test.ts` (server world, fake intercom client, fake clock): one notice per press, sent to the id and never by a `subagent-chat-<id>` name; `delivered`/`queued`/`gone` each named in the tower's boss event; the event marked `press`; decline resolved with its reason and kept 24 h; a run token refused; a second `done` refused 409 with the time. Update `tests/memory-command.test.ts`, `tests/wait-answer.test.ts`. | 1 |
| 3 | Snapshot: `bossWaits[].card`, `press`, the raiser's key, the `CARD_TEXTS` budget and `cut` | `src/net.ts`, `src/server/towermemory.ts` (`memorySummary`) | in `tests/wait-cards.test.ts`: the budget with its measured worst case; a cut card has `text`. | 1 |
| 4 | The card component and model, and its hosts: dock dialog, tower card row and comms, Zen card, head rows; 略過's confirm; 稍後 unchanged; copying a command; the phone CSS; both languages | new `gui/waitcard.ts`, `gui/waitcardmodel.ts`; `gui/waitpanel.ts`, `gui/towernotes.ts`, `gui/layer.ts`, `gui/zen.ts`, `gui/asks.ts` (`waitActions.press`), `gui/waits.ts`, `gui/style.css`, `gui/zen.css`, `gui/messages/*.json`, demo fixtures (`gui/fixture.ts`, `gui/demo-head.ts`) | `tests/wait-card-gui.test.ts`: the model's table (kind × state → parts, buttons, words); DOM per kind; a URL drawn as text and opened by nothing but a click (no `window.open` at mount); copy posts nothing; a paired device's secret card has no primary; legacy card; decline needs two taps; the 44 px rules. Update `tests/tower-wait-dialog.test.ts`, `tests/wait-panel-buttons.test.ts`, `tests/phone-targets.test.ts`, `tests/tower-memory-gui.test.ts`, `tests/imports.test.ts` (chunk caps, measured). Run the GUI key and layout tests with a Linux `navigator.platform` too. | 3 |
| 5 | Prompts and the tool's words | `prompts/tower.md`, `prompts/tower-run.md`, `prompts/head-run.md`, `prompts/main.md`, `src/memorytool.ts` | `tests/prompts.test.ts` | 1 |
| 6 | Docs and the demo: the sb-backend and how-it-works changes; `?waits=cards` (one card of each kind and state, the fonstar case first); screenshots in `~/.local/share/sbd-review/wait-cards/` for the boss (desktop Standard, Zen, phone) | `docs/…`, `gui/fixture.ts` | the demo loads in the existing demo test | 4, 5 |

Tasks 1–3 and 5 touch the server and prompts. Task 4 starts from task 3's commit. Task 5 can run beside 2–4. One worker each, sequential on one branch is simplest (tasks 2, 3, and 4 all touch `towermemory.ts` or its view).

## Risks

- **A card in the other language.** sb accepts it (boss, 11-07). Only the prompt and the brief's locale line steer the language; a tower that ignores them shows the boss a card in the other language, which the boss can still act on.
- **A run that cannot name the raiser.** A wait restated from a handoff note in a later run has no event: `restates` carries `from`, and a wait whose raiser is truly unknown is `self`. A tower that uses `self` to avoid the check loses only the **打開 …** button and the raiser's notice. That is visible on the card (塔台自己提出).
- **A run writes `memory.json` directly** (T3R-F005) and bypasses every check, as it bypasses proposals today.
- **A press after the tower already resolved the wait** on another device: the second device's press gets `No such wait` or `resolved already` as a refusal under the card, which then draws `ended` at the next snapshot.

## Decisions (boss, 2026-11-07)

| # | Question | Answer |
|---|---|---|
| WC-D1 | What 略過 does | Tell the tower and the main, two taps (the second confirms, with an optional reason), the wait struck through for one day (**稍後 and 略過**). |
| WC-D2 | Legacy waits | Shown with the tower's old text and 請塔台重寫 (**Legacy waits**). |
| WC-D3 | The card's language | No detection from the boss's messages: 「不需要吧，有可能是英文，而且我的sb是雙語言的啊..........明明就有 i18n」. The tower writes in sb's locale, named in its brief, and sb never refuses on language (**Language**). |
| WC-D4 | A secret card on a paired phone | Shown with 「請到電腦上輸入」 and no start button (**Buttons by kind and state**). |

## Implementation notes (tasks 1 to 3)

Choices the record left open:

- **Where the code is.** `src/server/waitcard.ts` (pure field checks and the stored shapes), `src/server/waitpress.ts` (the press), `src/waitbudget.ts` (`CARD_TEXTS`, pure so the net can use it). `towers.ts` sends a press through `reach.post` of the tower's identity and queues the event with `runs.boss(…, { press: true })`; the queued boss event carries `press: true` for the comms (task 4).
- **`towers.memory` can now return a promise**, since a press waits for the raiser's notice (at most 5 s). The memory route, the control socket, and `/boss memory` already await it.
- **`from` of a carried raiser.** A `restates` that names a legacy wait has no raiser to carry, so `from` is still required then; a card's `from` is carried.
- **Locale of the done label.** The tower's event names the button in the card's own `lang` (`我做完了` or `I'm done`), and a second press names it the same way.
- **A secret card's step 1** leaves the wait `open` with `press: { act: "secret", secretAsked }`; the brief row then reads `ready to enter <name>`.
- **Cut cards.** The page is shown `cut: true` for cards after the budget; reading one whole is the memory route's `read`, which now carries `card` and `press` on every entry.
- **Raiser key.** `buildNet` swaps the raiser's session id for the unit `key` when the session is a unit of the net, so a session id never reaches the page; a raiser that is not a unit has no key (the card has no 打開 button).
- **Secret shape.** The card's check is the board's `SECRET` list with its key-and-value pattern narrowed: `token: expired` passes, `token=abcdefg12345` is refused (a value of six characters or more with a letter and a digit). A bearer token, a PEM private-key header, and the long hex and mixed base64 runs are refused in prose. In a `url` the path is held only to the named key shapes (a commit's 40-character hash or a Google document's id passes), while the host, query and fragment are held to everything.
- **Remote callers.** The memory route (`tower/<ws>/memory`, `head/memory`) refuses `{ op: "press", act: "secret" }` from a paired device or an operate session with "Enter it at the computer" (WC-D4 on the server): the first step tells the raiser the boss is at this computer. Operate sessions with the box part reach every other memory op already (link-operate policy), so the doors above include them.
- **`queued`.** The tower's event says `<name> got it.` for `delivered` and for `queued`: the broker holds the message for a raiser that is live.
- **Mutation check.** Each refusal of tasks 1 and 2 was removed in turn and the tests failed, except `self gets no notice` (equivalent: a card with no raiser has no notice). The review round (RV-F001 to RV-F009) added `tests/wait-cards-review.test.ts`; each of its guards, and the four that had survived (the options' secret check, the per-run filter of `intercomEvents`, the boss-only press, the raiser read by id), was removed in turn and a test failed.

## Implementation notes (tasks 4 to 6)

Choices the record left open:

- **Where the code is.** `gui/waitcardmodel.ts` (pure: parts, buttons, words, raised line, the pressed line), `gui/waitcard.ts` (the DOM, the presses, Skip's confirm, copy, the read of a cut card, and `waitDialog`, which moved there from `waitpanel.ts`), `gui/waitpanel.ts` (now only the reply fold and its box; its Dismiss, comms link and stale note went to the card), `gui/demo-waits.ts` (`?waits=cards` and the stand-in for `press` and `read`). `waitActions` has `tell`, `press`, `read`, and `goto`; its `dismiss` is gone. An alert's `wait` carries `entry`, the wait as the snapshot has it. `fillNotices` no longer takes `here`: no row has a link to the comms.
- **Primary and the rest.** A choice has no primary (the options are equal rows). A pressed card drops its primary and keeps the line. Tap the folded line to reach the remaining actions; **Open <raiser>** stays on after a press (it only navigates, and the boss reviewed and kept it), and so do **Skip** and **Reply to the tower**. While a press is on its way or the stream is down, the buttons, the dock's footer Skip, and Open <raiser> are off; a disabled button is drawn flat with a dashed border in the dim text colour, with no opacity (its text keeps at least 4.5:1 on the dialog whatever the row around it does) and the state line is green only for a press (warning colour when the stream is down, the text colour for the secret's second step). An ended wait has no buttons at all. The reply fold is never turned off by the card; the box says "offline" when the stream is down (as before).
- **The secret card's first step** ends nothing: it is not wrapped by Zen's `send` (no knock), the dialog does not close, and the card shows step 2 from the press the reply carried until the snapshot catches up. Whether the raiser's `secret_drop` dialog is pending is read from the alerts in the dock and from the net in Zen; a row does not know and shows the "asked" sentence.
- **Clamp.** A part over 90 characters outside the dock's dialog is clamped to three lines with More; once it is laid out and fits (a wide window), the clamp and the toggle go. The clamp uses `-webkit-line-clamp` and the standard `line-clamp`.
- **A paired device** is `location.hostname !== "127.0.0.1"`, as `mountAsk`'s default; the screenshots of the phone use `localhost` so the secret card shows the paired-device rule.
- **Zen.** The card takes `.wait-card` rules in `gui/zen.css` (the Zen theme folder imports it). The tag is clay: `--zen-seal` is never a text colour (`tests/zen-contrast.test.ts`).
- **A cut card** is read once with `read`; the raiser's session id in the entry is dropped before it is drawn (the card has no Open button for it, since the net's unit key is not in the entry).
- **Mutation check.** Each guard was removed in turn and a test failed: a URL opened at mount, Skip sending at the first tap, the primary on a paired device's secret card, the secret's first step closing the dialog, the clipboard path posting, markup in a field read as HTML, a `javascript:` URL linked, the link without `rel`, the phone's 44 px rule, an Open button for a raiser that left, the page's own remote check.
- **Sizes.** `tests/imports.test.ts` caps are measured after the merges with Raven Keep and its head band: the map chunk +202 bytes (the words and the raiser finder), the lazy chunks +14,021 (the card, lazy), the stylesheet +4,755, the Zen theme +2,023; `demo-waits.ts` counts in the demo figure, not the page's.
- **GUI review fixes (round 1).** GR-F001 `fillNotices` takes a fifth argument, `where(key)` (the session view passes `locate(scene.net, key)?.base.id`), and the dock takes `deps.net`: Open <raiser> is offered only when the host names a route, so the head page never gets a link to itself. GR-F003 to F008, F010 and F012 as written in the sections above.

## Amendment: auto mode (2026-11-09)

The Out section left the alert queue as it was. Under auto mode (`2026-11-09-auto-mode.md` §6, §7; D8) a card recorded while it is on, and every boss wait open when it turns on, carries `parked: true`. A parked card is silent in the GUI (no system notification, sound, or Zen cue; out of the dock queue; phase 2), its raiser is told once under the `wait_parked` header (not `wait_card`, which means the boss's answer), and a secret card's start press is refused while it is on. The flag lives for the period: when auto mode ends the cards are ordinary open waits again, listed on the return list.

## Amendment: the terminal (2026-11-10)

Cards are also pressed in a terminal, with typed keys under the here mark: `/boss wait` in any pi, in a tower run's own pane, and the stand-in prompt's `/wait`, with the open cards shown as a block and a widget. The presses are this spec's `press` op unchanged, the secret's first step stays at this computer's keyboard and off under auto mode, and the log of a press records its door. See `2026-11-10-wait-cards-tui.md`.

## Amendment: auto mode's end (2026-11-21)

A parked card is no longer made an ordinary open wait when auto mode ends: it is closed (`resolved`, `returned`) and goes back to whoever raised it, to ask the boss again directly; a raiser that is gone closes it with nothing left for the boss. A card that was not parked is unchanged. See [2026-11-21-auto-return.md](2026-11-21-auto-return.md), AR-D3 and AR-D4.
