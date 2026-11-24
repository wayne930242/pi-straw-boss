# The supply board on the head page (2026-11-24)

Status: approved

Implemented on `feat/capacity-supply` (base `main` 92146c3d, 0.86.1). The boss approved the six frames in this folder without comments (`review.md`): `01-board-expanded.svg` to `04-board-phone.svg` for Standard, `05-keep-expanded.svg` and `06-keep-folded.svg` for Raven Keep. The numbers come from [device capacity](../2026-11-24-capacity.md); this record covers only how the head page draws them.

## What the page shows

The board section of the head page keeps its fold, rows, Ask, and Clear (`docs/specs/2026-11-09-board-view.md`). With a fresh device row (`net.capacity`) it adds:

- **The tray** (frame 01). One slot per point of `capacity.budget`, ten to a row. Each deployed unit is a chip over as many slots as its points, rounded up, so half a point still takes one slot. A unit's name and points come from the device row. Points that no unit names, such as a train that no todo names, fill plain used slots. The other slots are free and show "+". They pulse softly only while the device is flagged under capacity, which means room has been free for 10 minutes. Above the slots are the points against the budget and the load. Below them are the units' points and the count of free slots (`14 格可用`). Beside them, the barracks shows the ready count with one mark per ready item, up to 8. Ready work takes no slot.
- **No budget** (frame 03). Only the deployed chips are drawn, with "尚未設定補給預算". The tray has no free slot and gives no free count, because the free room is unknown.
- **The fold** (frame 02). The summary line keeps its counts and the device line and adds mini slots: the budget's slots, lit up to the points in use. With no budget, only the used slots are drawn.
- **Each main** (the commanders). A head row names the columns, `指揮官 · 已部署單位 · 待命工作`. A live main shows its kind's insignia before its name, its unit chips (or `未部署單位 · 0 點`), and its ready count. A quota pause adds a moon with its resume time beside the status word. A stale main gets an hourglass before its status word. The status words stay as they were.
- **Teammate devices.** One row per ally device of `net.link.allies`, showing its label, "隊友裝置", and online or out of touch. A device in two teams is still one row. No capacity figure for a teammate crosses to the page, so none is shown.
- **The phone** (frame 04, up to 640 px). The tray has four slots to a row. A two-point unit stays on one row. The barracks shrinks to one line. Each main shows `N 點 · 可接 N 件` in place of its chips.

Every slot and chip is a list item with its own label (`api-build · 2 點`, `空格 07`). Icons are hidden from assistive technology because the words beside them say the same thing. The pulse and the mist run only under `prefers-reduced-motion: no-preference`, and the page's calm stops them.

## Words (boss, frame G)

Standard says 工作板 → **戰況板**, 本機主控 → **指揮官** (the head over the mains), 問進度 → **詢問戰況**. English follows: *Situation board*, *Commanders*, *Ask for a sitrep*. The prompt the button sends is unchanged.

## Views

- **Raven Keep** (`gui/themes/raven/`) draws the same DOM in its own sheet, sprite, and sentences, in both languages. A slot is a grave, and each deployed bat lights a candle in every grave it holds, with `蝙蝠 · <name>` under the candles. Free graves breathe mist while the device is under capacity. Ready work waits as bats before the keep's gate (閣門). The board is 管家手記 and the commanders are 墓穴中的血僕. A pause reads `合棺 · HH:MM 甦醒` under a coffin, and a stale main reads `群鴉盤旋 · …` under circling crows. A teammate device stands in fog (`霧中 · 產能不明`). Raven keeps 問進度.
- **Geek** keeps the plain lines and hides the tray, the mini slots, the chips, the icons, and the teammate rows (`geek.css`). Its sentence pack keeps 工作板 and 問進度.
- **Zen** shows no capacity. It hides the page that carries the board, and none of its files read the board or the capacity row.

## Data and egress

`MainRow.units` (`src/capacity.ts` `joinCaps`) lists a main's deployed units: each owner of a running in-progress todo with its points, then each running worker that no such todo names, at 1 point. The units sum to the main's points. Like `MainRow.workers`, they are kept only in the local `_device.json`. `boardview.ts` copies them onto this computer's board rows (`BoardViewRow.units`), and those rows reach only this computer's page. `board_read`, the link's `WireCap`, remote turns, and the operate slice carry no unit name, and `src/server/operatesanitize.ts` is unchanged.

## Code and tests

`gui/supply.ts` draws the tray, the mini slots, each main's supply line, and the teammate rows. `gui/board.ts` places them and rebuilds the tray under its own signature, so a load change never replaces a row's buttons. Icons are `#i-unit`, `#i-slot`, `#i-lit`, `#i-barracks`, `#i-paused`, `#i-stale`, and `#i-fog` in `gui/index.html`, with `raven-` twins. Tests: `tests/supply-page.test.ts` covers the layout, the DOM, motion, Geek, and Zen. `tests/capacity.test.ts` and `tests/capacity-board.test.ts` cover the units and their egress. `tests/raven-words.test.ts` and `tests/raven-theme.test.ts` cover the words and the sprite.

## Known differences from the frames

- The fold and the tray do not name the device ("Mac Studio"), because the net snapshot carries no device label.
- A teammate device reads "失聯" without its minutes, because the ally rows the page gets carry no age.
- The status words for a pause and for a stale main stay 額度停機 and 閒置超過 2 小時, not the frames' 配額暫停 and 閒置過久.
