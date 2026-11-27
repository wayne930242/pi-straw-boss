---
title: The browser view
description: The whole net in your browser, live, and the questions agents wait on, answered in place.
---

`/boss gui`, from any pi session, opens the whole net in your browser.
The sb server serves it, one per computer, so it does not depend on which session runs.
[Try the demo](https://wayne930242.github.io/pi-straw-boss/): it runs with made-up agents and needs nothing installed.

![The straw net in the Standard view: bases with their towers, agents, and subagents in live states, with the counts and the waiting units in the header](/pi-straw-boss/docs/img/straw-net-gui.png)

## The map

Each workspace is a **base**, with its tower, its tabs as **squads**, and every agent and subagent as a **unit** in a live state: working, waiting on you, commanding (idle while a subagent or a monitor of it works), idle, finished, or failed.
Click a base to zoom in, and click a unit to read its chat as a live comms log.
A unit's icon and the word beside its name tell its kind; [Icons](/pi-straw-boss/docs/guide/icons/) shows every icon and what it stands for.
The tower and the head tower keep their own icons, and a unit with no known kind keeps the plain main, member, or subagent icon.

<p align="center"><img src="/pi-straw-boss/docs/img/gui-comms.png" width="49%" alt="A unit's comms: its chat as a live log, the messages queued for its next turn, its todo list, its background monitors, and its dossier"> <img src="/pi-straw-boss/docs/img/gui-alert.png" width="49%" alt="An alert dialog with the question a unit waits on, with its options to pick and a note to add"></p>

### A unit's comms

It shows its chat, the messages queued for its next turn, its todo list, its background monitors, and the documents it shows.
When a main's todos carry a plan (a dependency, an owner, a defer, or a graph name), its todo box draws them as steps by dependency, each with its state in words, its owner (a link to that agent's session, with **Focus** to bring its pane forward), what it comes after, and what it waits on until when.
The whole checklist folds under the plan, so finished tasks, points, anchors, and the last run stay a tap away. The head page's work board draws the same plan for each main.

<p align="center"><img src="/pi-straw-boss/docs/img/gui-plan-board.png" width="57%" alt="A main's plan on the head page's work board: its open todos in steps by dependency, each with its state in words, its owner with a link and Focus, what it comes after, and what it waits on until when"> <img src="/pi-straw-boss/docs/img/gui-plan-session.png" width="41%" alt="The same plan in the session page's todo box, with the whole checklist folded under it"></p>

Type into the session from its composer; a file pasted, dropped, or picked with **+** (20 MB at most) is stored in a private temp folder and its path goes into the message.
On a desktop, click into a unit's terminal and it takes your keyboard.
Each message has a **Copy** button that copies the whole message (an agent's message as the markdown it wrote), also over plain http on your Wi-Fi, where the browser has no clipboard API; if even that is refused, the message is selected, the button says Selected, and you use the browser's own Copy.
Text you select stays selected while new messages and tool results arrive: the log waits for you to let go before it follows its end or redraws that message.

A review in chat or in a Markdown document can ask you to choose one item from each group or tick as many items as you like, including none.
You can change your picks and add comments until you press **Send**; the answered review shows which items you chose.

### Alerts
A unit that waits on you raises an alert, and the alerts queue up.

| Key | Does |
| --- | --- |
| Space | Opens the next alert |
| F | Enlarges the top dialog |
| Escape | Closes it |
| Arrows | Choose an option |
| Tab | Moves to the question's own-words box and note, then the next question |
| Enter | Confirms |

The first three do nothing while you type.
The page answers `ask_user_question`, `robot_hand`, pi-code's hook confirmation, and any extension's `select` and `confirm`.
Other dialogs show read-only, and `secret_drop` always takes its secret in the terminal, never on a page.
An answer that leaves its next step in a terminal (robot_hand's prompt and pane choices) shows a small card to finish it, with a link to the full terminal for ssh and vim.

### A tower's wait for you

It is a card, not a line of text. It says what happened, what you do, where (a link to open, or a command to copy; sb never runs one), what happens after, and which session raised it.
Pick a row, then press **Send**: a tap alone presses nothing.

| Row | Does |
| --- | --- |
| The acts that fit: *I'm done*, a choice's options, or the steps of a secret entered in the terminal | Pick one, then **Send** |
| **Reply to the tower** | Shows the reply box; Enter sends it |
| **Skip** | Shows who will be told and an optional reason; **Send** tells the tower and the session |

A card folded into a tower's row unfolds when you tap it.
A card from the head tower says so in its own words (主塔台 in Traditional Chinese, 鴉閣 in Raven).

<p align="center"><img src="/pi-straw-boss/docs/img/gui-wait-answer.png" width="49%" alt="The dialog for a tower's wait: the question, the answer box with a reply typed, Send, the link to the tower's comms, Later, and Dismiss"> <img src="/pi-straw-boss/docs/img/gui-settings.png" width="49%" alt="The settings page: this device's view, reminders, sound and volume, and language, with the sections for phones and devices, teams, and the server below"></p>

### Notices and reminders
A unit that fails or finishes, and a monitor that fails or goes quiet, raises a quiet notice under the header's Notices button; only a unit waiting on you raises the prominent alert.
Switches in the settings page (the gear) raise a system notification when a unit waits on you, fails, or finishes; a sound plays only for what waits on you.
Finished subagents on the map are dismissed one by one or all at once (Dismiss finished).

The page reads in English or Traditional Chinese, following your browser, with a language menu in the settings.

## Opening and closing

- **+ New base**, the last card on the map, opens a base in a folder you pick, with one member and no tower. The folder picker stays inside your home folder and skips hidden folders.
- **+ Member** adds a member to a base without a tower; **+ Main** adds a main, in a tab of its own, to a base with a tower.
- Each opening form takes an optional first message. While the unit opens, a deploy panel shows the real steps (create, start, join the net, deliver the first message) with each step's clock, and names the step and the reason when one fails.
- A pi that must confirm [project trust](/pi-straw-boss/docs/reference/how-it-works/how-it-works/#before-pi-starts-in-a-folder-the-settings-check) before it starts asks in the page as an alert too: Trust, Trust this time, or Don't trust.
- **Quit** closes a base, a squad, or a unit after a confirmation: each agent quits pi as `/quit` would, then its pane, tab, or workspace closes. Nothing closes if one of them refuses.
- **Stash** puts a whole base away under its label, and the header's **Stashed** list opens it again with **Pop**, every pi resumed from its own session file in its old role. A stash refuses, naming why, while anything a resume would lose is there: a running turn, a queued message, an open dialog, a running monitor, a subagent, or a busy shell.

The same operations are typed commands too: `/boss open`, `/boss close`, `/boss stash`, `/boss pop`, `/boss send`, and `/boss answer`. See [Commands](/pi-straw-boss/docs/reference/commands/).

## Views

Each device picks its view on the settings page: Auto, Standard, Geek, Raven Keep, or Storybook. Zen is not a view but a mode you enter from any of them (below).
`/boss gui view <name>` sets the default for devices on Auto; no page, paired phones included, can change it.

- **Standard** is the map above.
- **Geek** is a terminal: black, monospace, high contrast, no motion, and each state also as a text tag such as `[WORK]`, `[WAIT?]`, or `[ERR!]`.
- **Raven Keep** is a gothic skin of Standard: the same layout, its own icons, role names, and sounds. Each unit kind has its own Raven Keep icon.
- **Storybook** is a cute, soothing picture-book skin of Standard with the same words (below).

<p align="center"><img src="/pi-straw-boss/docs/img/gui-geek.png" width="70%" alt="The Geek view of the map: black, monospace, high contrast, with each unit's state as a tag"></p>

### Storybook

Storybook (繪本) draws the net as a pressed-flower notebook: each card is a paper page held by washi tape, with a thin hand-drawn line and a fine paper grain, and the question card is a ruled page.
It follows your device's clock. From 06:00 to 17:59 it is cream paper with deep plum ink; from 18:00 to 05:59 it is grey-violet pages on a night-blue sky.
The page changes over at the boundary by itself, with no reload, and a page opened at night never flashes the day first.
Look beside the animal icons to read a unit’s state: pencil for work, envelope for waiting, flag for an error, crescent for idle. The shapes stay readable with motion off. Butterflies cross the map by day; fireflies glow at night. Turn on Background sound to hear birds or crickets with the scenery. Sound effects is separate: turn it on for a kalimba note when a question needs you.

<p align="center"><img src="/pi-straw-boss/docs/img/gui-storybook-day.png" width="49%" alt="The Storybook view by day: cream paper cards held by washi tape, hand-drawn outlines, plum text"> <img src="/pi-straw-boss/docs/img/gui-storybook-night.png" width="49%" alt="The Storybook view at night: grey-violet cards held by grey-green tape on a night-blue ground"></p>

## Zen

Zen is for the hours when you are answering the net rather than steering it.
The **Zen** button in the header, beside the gear, enters it from any view (on a phone it is an ensō; in Geek it reads `[Zen]`).
This device stays in Zen across reloads until you leave it; another open tab is never switched.
Leaving shows your own view again: Standard, Geek, Raven Keep, or Storybook. The settings page sets Zen aside while it is open.

When something waits for you, Zen shows that one thing alone: no map.
A card never takes the screen by itself: one quiet line says how many wait, and **Enter**, or a tap on the line, takes the next, blocking questions first.
A card you are on is never replaced or pulled away; if its question is answered elsewhere, it stays and says so.

<p align="center"><img src="/pi-straw-boss/docs/img/gui-zen-item.png" width="49%" alt="The Zen view with one item: a robot_hand question on an ink-dark page, its choices as lines of text"> <img src="/pi-straw-boss/docs/img/gui-zen-alone.png" width="49%" alt="The Zen view with nothing waiting: a breathing circle and a line on mindfulness"></p>

When nothing waits, Zen shows a breathing circle and a short line on mindfulness or stillness.
A companion session shows its live log and composer.

### Keys

| Key | Does |
| --- | --- |
| Enter | Takes the next card; then presses its main button (Allow, Trust, the first choice, Run), never inside a text field. On a card that waits for you, it picks the first row and moves on to **Send**. |
| Enter or Space | Ends the breathing pause early |
| Esc | Answers or skips the card; a second Esc within 600 ms leaves Zen for your view |
| `[` or `]` | Steps to a session to keep you company |
| H | Opens *Context* on a card: the unit's session log inside the card, read-only, while you can still answer |
| ⌘K (Ctrl+K off a Mac) | Opens a command palette for the page's actions |
| Shift+Esc | Inside a terminal, lets the keyboard out |

<p align="center"><img src="/pi-straw-boss/docs/img/gui-zen-history.png" width="49%" alt="The Zen view with an item's Context open: the unit's session log inside the card, above the question's choices"> <img src="/pi-straw-boss/docs/img/gui-zen-palette.png" width="49%" alt="The Zen view's command palette open over the companion session"></p>

### Cards of their own
Besides questions, Zen shows as cards a tower's wait on you, a confirm a teammate's tower asks of this computer, a dialog a Straw Link box forwarded, a phone's pair request, and a tower's memory proposal.

### Headless runs
With headless tower runs on, a dialog a run waits on is a card on this computer's page only, queued for Enter like any other: Allow or Deny, an option and Send, or a field and Send. An approval card holds off a fast or held Enter for 400 ms.
The input under the circle starts with a button that names where your words go. Pick a tower from its list, or type `@<workspace> text`, and that tower's conversation is your companion until you press Esc or go back to the head; the message its run is writing shows in still grey text.
See [Headless runs in Zen](/pi-straw-boss/docs/reference/how-it-works/browser-view/#headless-runs-in-zen).

### Sound and music
Sound effects follow the settings page's Sound effects switch (off by default): a singing bowl when an item takes the screen, a wooden fish when one is done.
Put audio files in `~/.pi/agent/straw-boss-music/` and Zen shows a ♪ in the corner that plays them on a loop, while the Background sound switch is on.

<p align="center"><img src="/pi-straw-boss/docs/img/gui-zen-menu.png" width="49%" alt="The Zen view's corner menu: language, sound controls and Exit Zen"> <img src="/pi-straw-boss/docs/img/gui-zen-music.png" width="49%" alt="The Zen view with a music folder: the ♪ switch and the open track list"></p>

The head tower lives under Zen's breathing circle; see [The head tower](/pi-straw-boss/docs/guide/head-tower/).

## On a phone

The page works on a phone, over your tailnet or on the same Wi-Fi.
See [Phone and remote access](/pi-straw-boss/docs/guide/phone/).

## More

Every rule of the page is in [Browser view](/pi-straw-boss/docs/reference/how-it-works/browser-view/).
