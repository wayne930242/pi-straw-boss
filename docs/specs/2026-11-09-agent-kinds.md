# Agent kinds (round 9)

Status: decided by the boss (D10 to D15); ready to build. Todo #137 (it absorbs the integrator as a visible sub-role of main). Base: `main` 27f86373 (v0.68.0). The proposal the boss answered is `~/.local/share/sbd-review/agent-kinds/proposal.md`.

The reviews are all in `~/.local/share/sbd-review/agent-kinds/`. Each finding and where it is resolved is in the [Review history](#review-history); round 6 applies the boss's answers ([Round 6](#round-6-the-bosss-answers)):

- `review.md`: AK-F001 to F016;
- `rereview.md`: AK2-F001 to F009;
- `review3.md`: AK3-F001 to F008;
- `review4.md`: AK4-F001 to F006;
- `review6.md`: AK6-F001 to F012 (round 6; there is no review 5);
- `review7.md`: AK7-F001 to F009;
- `review8.md`: AK8-F001 to F007.

## Why

sb knows four roles, and each is a position, not a duty: `tower`, `main`, `member`, `train` (`src/state.ts:33`).

- A main can coordinate a plan (spec-chain, sb backlog), run a project's merge trains (integ FE2, integ v3), or mind one system with no end (CR9 switch, v1 redis). The page names all of them 主智慧體.
- A subagent is 子智慧體 whether it is a scout, a planner, or a reviewer.

This spec adds a second axis on top of the position: the **kind**. A coordinator's plan adds a third, shown but not a kind: its **graph** (D10).

## Boss decisions (2026-11-09)

D1 to D5 are the boss's form answers to the proposal, with the option labels quoted verbatim. D6 to D9 were added in chat. D10 to D13 answer the round-5 questions (`decide.md`). D14 and D15 came after round 6, and D16 after the ally view (todo #152).

| # | Question | Decision (verbatim) |
|---|---|---|
| D1 | Coordinator kinds (revised by D10) | 「就這四種」: 鏈主 (chain: one big requirement, relay), 調度 (fan-out: many related parallel tasks), 整合員 (merge train: takes cars, schedules trains), 值守 (standing: no end, minds a system or machine) |
| D2 | Who approves a coordinator's switch | 「自己換，寫理由、留紀錄，GUI 顯示」: no tower or boss approval |
| D3 | What a watchdog may do | 「只回報給派它的協調者」: it never interrupts or stops anything |
| D4 | Worker kinds (fixed at spawn, never self-switch) | 「工作者（實作）」「偵察」「規劃」「審查（含視覺審查）」「監控者」「火車」 |
| D5 | Names | 「你先擬，我再挑」: see [Names](#names) |
| D6 | What a kind is | 「不同種類的 worker agent 的意涵在於送入的 prompt 不同，他們有不同的預設行為以及和 user 的互動方式」 |
| D7 | Kind prompts | 「請確認這個 prompt 一律遵循精簡原則」 |
| D8 | Context and tools per kind | 「像是 watchdog 一般會需要監控的是其他 herdr state，所以可以先把相關脈絡給他。用類似的技巧減少token的使用，甚至可以給他們比較少的工具（除了 worker，worker 需要全套工具），然後審核者或視覺審查會需要 playwriter or agent browser and computer use 等，也會需要用 show me html 給我看成果等等」 |
| D9 | Kind words and themes (asked whether icons change by kind; they stayed by position until D16) | 「那石像鬼就不可能是職稱，這樣的話乾脆統一用程式用字而非主題用字」 |
| D10 | Q1, coordinator words | 「鏈主和調度不太行，應該都是協調者，但是要看拓樸形狀…其實應該都是協調者，只是挑選的圖不同，或許不應該當成種類，而是應該當成不同拓樸圖的協調者」; follow-up: 「整合員、值守仍是獨立種類」 |
| D11 | Q5, where the role prompts live | 「不用複寫吧？我就是在規劃 straw boss 的架構。」; choice: 「sb 出貨完整角色包，移除覆寫」 |
| D12 | Q3, a standing main and the boss | 「這個要落實，會需要進入自動模式的時候，讓 robot hand, secret drop 等等可能導致 agent waiting 的行為直接被擋掉。可能可以讓主塔台宣告進入 auto mode，那所有的 agent 的 waiting 都會被監控取消並且說明阻擋原因」 |
| D13 | Q1 worker words, Q2, Q4, Q6, Q7 | Q1: the recommended worker words; Q2 「可以」; Q4 「要先宣告」; Q6 all three accepted; Q7 「接受」 |
| D14 | The main's prompt and the plan | 「main 的提示詞要改，要確定 plan 才會拿到派供相關提示詞」 |
| D15 | Q8 graph words; Q9 `/plan` | Q8 「單一迴圈／分支匯流／多工編排」 (en single loop / fan-out / orchestrated); Q9 「讓它們消失」 |
| D16 | Icons by kind (reverses D9's "icons stay by position") | 「不同類型的 worker agent 等，gui 和 herdr plugin icon 上，都要有所區分」 (11/11, todo #152) |

What the decisions require of the design:

- **D6: a kind is the prompt a session runs.** The prompt fixes the kind's default behaviour and how it deals with the user. A coordinator's switch swaps the addendum its main runs. The page's kind label is derived from that prompt and never stored apart from it.
- **D7: concise kind prompts.** A kind prompt says only what differs from its base (`main.md`, or the role's base). It repeats no rule, carries no reasoning the agent does not need in order to act, and states the behaviour directly. It follows solid-loop's instruction rules and agent-terse.
- **D8: per kind, three things.** Preloaded context (so the kind does not spend tokens finding it), a tool set (`worker` full, every other worker kind reduced), and how it presents to the boss (reviewers by `show_doc` HTML pages; visual reviewers with Playwriter, agent-browser and computer-use). All three are in §9.
- **D9: one plain word per kind.** Each kind has one word in the base messages (zh-TW and en), the same in Standard, Raven and Geek. The Raven names, 車伕/Coachman included, are withdrawn. Icons stayed by position here; D16 reverses that (§11).
- **D10: three coordinator kinds.** `coordinator` (協調者), `integrator` (整合員), `standing` (值守). Chain and fan-out are not kinds but graphs of a coordinator's plan. The page reads the graph from the main's own todos and shows it beside the kind word (§2). It changes when the plan changes, with no tool call.
- **D11: sb ships the role pack.** sb's `roles/` holds every pi-herdr-agents role the kinds need, with its prompt, tools, and interaction. It replaces pi-herdr-roles and the weihung-basic-agent overrides (§9, phase 2).
- **D12: a standing main asks only through the tower's wait card.** Auto mode, which blocks and cancels every wait, is its own spec (todo #140). Under auto mode a standing main must not wait at all (§9).
- **D14: dispatch rules come with the plan.** `main.md` keeps what every main needs. The dispatch rules move to addenda that sb appends only once the main's own todos name a graph, read as in D10 (§2a). Until then the main carries its work itself.
- **D16: icons by kind.** Each kind has an icon of its own on the page and a glyph of its own in Herdr's sidebar and the tower's dashboard (§11). The tower and the head keep theirs; a unit with no known kind keeps its position's icon. It replaces D9's last sentence.
- **D15.** The graph words are final. `/plan` and the `plan` skill leave with pi-herdr-roles.
- **D13.** Operate controllers see the kind word and the graph (§12). A `train` todo needs the integrator kind (§4). The tool sets in §9 stand. The watchdog sees only what the net shows (§10).

## What sb has today

- **Roles.**
  - `Role` is derived in `createKit().role()` (`src/state.ts:118-123`).
  - Towers and mains record their role by session file in `<state>/roles/` (`RoleRecord`, `src/roles.ts:22`). The record carries `openedBy`, because pi writes no entry before a conversation exists.
  - The opener's one-time token `sb_open_main` is consumed in `claimOpened` (`src/session.ts:76-83`).
- **The integrator is derived from the yard.**
  - **Who it is.** It is the main that a live `yard.json` names as writer (`integrators()`, `src/trainsign.ts:15-26`), and the writer's pid must be alive (`src/server/traingate.ts:59-63`).
  - **Who writes the yard.** `publish` writes it for any main whose todos hold a `train` row (`src/trainguard.ts:516-521`, `:565-571`).
  - **What depends on it.** The yard link on the card (`src/server/trainyard.ts:199`, `gui/trains.ts:192`, `:205-215`), the sidebar mark and the tab order (`src/order.ts:51`, `:101`), and a member's sort (`whoMember`, `src/presence.ts:42-46`).
  - **The rules around it.** "One integrator per project" is a prompt rule (`prompts/tower-run.md`). `prompts/integrator.md` is not a system-prompt section (`src/briefing.ts:5`); the integrator reads it because its open request says to.
  - **Live state.** Today's integrators run legacy ledger trains (`<state>/trains/<project>/<app>.json`). They have no `train` todos and no yard (`trainboard/` is absent).
  - **Takeovers.** They often start as takeovers. The boss starts a fresh pi on a damaged session, pi auto-names it, and minutes later it calls `boss_rename integ …`. AK3-F001 found five such takeovers in three days, and both live integrators are takeovers.
- **The integration switch.**
  - It is read when the train guard registers, at every extension load (`src/index.ts:82`), and by the prompt set at every `session_start` (`src/trainswitch.ts:88-93`, `src/session.ts:93`).
  - pi re-runs every extension factory on `/reload`, `/new`, `/resume`, and `/fork` (pi 1.3.0 `main.js:590-603`, `loader.js:510-516`), so each of them re-reads both.
  - `read(name)` reads the source folder, and `integrator.md` has no integration markers.
- **The prompt a session runs.** `briefing.begin` sets it at `before_agent_start` (`src/session.ts:240-243`). A role change mid-run arrives as a steer (`src/briefing.ts:10-35`).
- **Subagents.**
  - **In the child.** sb's extension runs the dialog bridge and trust relay in every pi-herdr-agents child, then returns before any net tool (`src/index.ts:54-62`). A child already calls the sb server for hygiene (`procs-hello`, `src/hygiene.ts:224`).
  - **The parent's artifacts.** The server reads each child from them: `subagent-activity/<id>.json` (no role) and `subagent-scripts/<name>-<id>.sh` (`scriptRead`, `src/netdata.ts:95-99`, matched by id at `:126`).
  - **What the first launch script carries.** It has `PI_SUBAGENT_AGENT`, `PI_SUBAGENT_ID`, `PI_SUBAGENT_SESSION`, and `PI_SUBAGENT_ACTIVITY_FILE` (pi-herdr-agents 6f530b9 `launch.ts:806-807`, `:826-828`).
  - **A resume.**
    - It mints a **new id** (`launch-resume.ts:49`).
    - It writes `<name>-resume-<ts>.sh` with no id in the name and no `PI_SUBAGENT_AGENT`, but with the same `PI_SUBAGENT_SESSION` (`:117-155`).
    - It restores `--tools` from the session policy (`:136-147`).
    - The resumer is not always the spawner.
  - **What is stable.** A child's **session file** is the only stable link between its launches. Every script carries `PI_SUBAGENT_ID` and `PI_SUBAGENT_SESSION`, the resume script included. The script format is internal to pi-herdr-agents, not a documented contract.
  - **A resumed child today.** `subagents()` finds a child's pane by the id in its session file's name (`src/netdata.ts:35`, `:57-76`) and finds its script by `-<id>.sh` (`:126`). A resumed child matches neither, so while it runs it shows as `done`, named by its hex id, with no `file` (reproduced in AK4-F002).
  - **pi does not create the `.jsonl` at once.** It writes the session file only with the first user or assistant message (`session-manager.js:794-812`). pi-herdr-agents writes only the `.pi-herdr-subagent-policy.json` beside it.
- **Tools in a child.**
  - **The allowlist.** A role's `tools:` becomes pi's `--tools` allowlist, plus `caller_ping`, plus `subagent_done` for a role that does not auto-exit (`launch.ts:777-781`, `launch-command.ts:56-70`). `spawning: false` denies the lifecycle tools.
  - **Overriding it.** A spawn's `tools` overrides the role's list (`docs/tools.md:162`).
  - **How pi keeps to it.** pi silently skips listed names it does not have. It pushes every allowlisted tool back into the active set at each `registerTool` (`agent-session.js:2841-2923`), and keeps unlisted extension tools out of the registry (`:1123-1129`).
  - **The boss's overrides.** The roles in `~/projects/weihung-basic-agent/agents/` have no `tools:` line, so their children run with every tool today.
- **Where the roles come from.**
  - **The pack.** pi-herdr-agents ships no roles. A role pack registers a `roles/` folder on the event `pi-herdr-subagents:roles:discover:v1` (`docs/roles.md`, "Publish a role pack").
  - **Precedence.** Project, then global (`~/.pi/agent/agents/`), then packages. Two packs that both carry a name disable it, with a diagnostic (ADR-0003, "Catalog and precedence").
  - **Today's set.** weihung-basic-agent pins `npm:pi-herdr-roles@0.1.0` (`scripts/pi_root/pins.py:14`) and installs five global overrides: `worker`, `scout`, `reviewer`, `visual-tester`, `adversarial-reviewer`. `planner` has no override, so it runs pi-herdr-roles' own.
  - **pi-herdr-roles also brings** the `/plan` command and the `plan` skill (`extensions/index.ts:34`), and an `orchestrate` skill that basic-agent filters out.
  - **What the overrides carry over pi-herdr-roles** (diffed against 0.1.0):
    - `worker`: a new body. It is dispatched by a main, and the brief bounds it. It asks the main only for a material unknown, with a recommendation. It commits and pushes as far as the authorizations reach. It keeps the turn open until what it started has returned, then stops it. Its final message follows agent-terse. pi-herdr-roles' "Engineering Standards" and its long worktree contract are dropped.
    - `scout`: `thinking: low`; the output line "by the `agent-terse` skill"; the "What to look for" list dropped.
    - `reviewer`: it runs `git diff base..head` itself; it says whether staged, unstaged, and untracked files are included; non-Git sources need comparison evidence; agent-terse; the last line `Blocking: P0=<n> P1=<m>`, which tooling parses.
    - `visual-tester`: a new body. Browser work follows `rules/browser.md`, with a checklist; it gets approval before any state change; it is read-only on source; it saves its report with `write`. The `chrome-cdp` skill and the `scripts/cdp.mjs` setup are dropped.
    - `adversarial-reviewer`: the `orchestrate` note and the `Blocking` line.
    - Every override drops its `tools:` line.
- **A plan's graph.** `prompts/planning.md` §1-§2 has a main choose `single-loop`, `fan-out/fan-in`, or `orchestrator-worker`, and write it in each todo's `metadata.graph`. A single-loop plan is not stated: it is one todo whose `metadata.anchor` names its check.
  - A main's bridge sums its todos for the card (`todoOfBranch`, `src/todo.ts:24-29`). `Todo` keeps only `metadata.sb` (`src/items.ts:14`), and the hub rebuilds the sum field by field (`src/dialogs.ts:145`), so a graph would not reach the net today.
  - **What mains write** (review 6, main sessions of the last 7 days): `orchestrator-worker` in 18 sessions, `fan-out` in 7, `fan-out/fan-in` in 3, `single-loop` in 5, `single` in 1, and `single-loop then worker`. Only 20 of 285 sessions with todo state wrote any graph. pi-anchorloop puts `metadata.anchor` on its loop todos (`pi/book.ts:415`, `:531`), so an anchor says nothing about a plan.
- **The dispatch rules today.** Every main runs them from its first turn:
  - `main.md:3` (split by owning app, worktrees, the worktree path), `:4` (plan first; dispatch in parallel), `:6` (the brief), `:7` (check results; the boss authorizes merges and deploys);
  - `planning.md` §5 (run the plan: dispatch, check, unblock).
  - sb's only other system text is the tower's "Since your last run" lines (`src/session.ts:242-246`) and a tower run's brief (`src/runmode.ts:434-437`). Neither carries dispatch rules.
- **sb sees every dispatch.** Its `tool_call` handler for `subagent` and `subagent_resume` (`src/session.ts:252-263`) waits for the workspace check, blocks a tower, and promotes a member.
- **The page.**
  - `Unit.role` (`src/net.ts:30`) comes from the pane token `sb_role` (`:92`, `:110`), published and cleared by presence (`src/presence.ts:75`, `:133`, merging by key).
  - A subagent unit has a name, a mark, and a note (`src/net.ts:121-124`).
  - `roleName` (`gui/render.ts:32`) is used at `:34`, `:158`, `gui/tokens.ts:15`, `gui/layer.ts:111`, `gui/drawer.ts:81`, `gui/dossier.ts:26`, `gui/zen.ts:145`, `gui/chat.ts:98`, `gui/box.ts:38`, and `gui/trust.ts:19`.
  - Themes override nouns through `NOUN_KEYS` (`gui/nouns.ts:8`). Geek's brackets are state tags (`gui/themes/geek/geek.css:92-101`).
- **Link.**
  - The ally board entry has no role (`src/link/kinds.ts:77`).
  - The operate slice spreads `Unit` (`src/operateslice.ts:11-13`), and the controller's sanitizer keeps known fields only (`src/server/operatesanitize.ts:129`, `:154`).
  - A controller can mirror a pane and read its history (`src/operateroutes.ts:38`, `src/server/operatehost.ts:28`, `src/server/operatebox.ts:98`).

## Design

### 1. Values

The code name is **`duty`**, because `kind` already has five meanings (`Row.kind`, `NetEvent.kind`, header `kind=`, a train step's `kind`, `metadata.sb.kind: "train"`). The pane token is `sb_duty`; the tools are `boss_duty`, `watch_read`, and `watch_report`; the unit field is `Unit.duty`. The page says 種類/kind.

`coordinator` also names a car slip's sender. The slip field `coordinator` appears in `main.md:23`, `integrator.md:6`, and `train.md:17`. The prose uses the word for the sender in `main.md:23`, `:25`, `integrator.md:3`, `:8` ("never send a coordinator a notice"), `:12` ("intercom to its coordinators"), and `train.md:13` (AK8-F007). The message 「{ticket} 的協調者聯絡不上」 (`yard_notice_escalated`) does the same. A standing main that sends a slip is the slip's coordinator without being of the coordinator kind (AK6-F009). The slip field keeps its name, because it is a contract. The prose around it says "the slip's sender", and the message becomes 「{ticket} 的送車者聯絡不上」 / "the sender of {ticket} cannot be reached" (Raven's sentence too).

```ts
// src/duty.ts (new; no pi imports, so the server and the page load it)
export const COORDINATOR_DUTIES = ["coordinator", "integrator", "standing"] as const;
export const WORKER_DUTIES = ["worker", "scout", "planner", "reviewer", "watchdog"] as const; // "train" stays the Role
export type Duty = (typeof COORDINATOR_DUTIES)[number] | (typeof WORKER_DUTIES)[number];
const AGENT_DUTY: Record<string, Duty> = { worker: "worker", scout: "scout", planner: "planner", reviewer: "reviewer", "visual-tester": "reviewer", "adversarial-reviewer": "reviewer", watchdog: "watchdog" };
export const GRAPHS = ["single-loop", "fan-out/fan-in", "orchestrator-worker"] as const; // planning.md §1; a graph is not a duty (D10)
export type Graph = (typeof GRAPHS)[number];
/** A todo's `metadata.graph` as mains write it (review 6's live values) → a graph; anything else has none. */
export const graphOf = (v: unknown): Graph | undefined =>
	v === "orchestrator-worker" ? v : v === "fan-out/fan-in" || v === "fan-out" ? "fan-out/fan-in" : v === "single" || (typeof v === "string" && v.startsWith("single-loop")) ? "single-loop" : undefined;
/** pi-herdr-agents role name → worker duty; a name not listed (or `constructor`, `toString`) has none. */
export const dutyOfAgent = (name: string | undefined): Duty | undefined => (name !== undefined && Object.hasOwn(AGENT_DUTY, name) ? AGENT_DUTY[name] : undefined);
```

A train's kind is its role. `coordinator` is the kind of every main that declares none.

### 2. A main's kind: one function feeds the prompt, the label, the gate, and the yard

- **Declared duty.**
  - `State.duty` and `Saved.duty` hold it. Every `boss_duty` entry carries all four fields, `{ duty, dutyFrom, dutyWhy, dutyAt }`, because `s.saved` merges entries field by field (`src/session.ts:94`).
  - At `session_start`, `s.duty = s.saved.duty`. In phase 2, the role record's `duty` and `claimOpened` can also set it (§6). Every write of a duty (`boss_duty`, the migration, `claimOpened`) sets `s.duty` in the same step.
- **Migration: only while `s.duty` is unset (AK4-F001).**
  - **The guard is the live value.** The guard is `s.duty`, not `s.saved.duty`, which is read only at `session_start` (`src/session.ts:94`). A declared kind always wins, and a session gets at most one migration entry, ever: once one is written, `s.duty` is set for the rest of the process, and the entry sets it at every later start.
  - **Not while integration is off.** The migration is skipped while integration is off (`!(trainOn && !prompts.off)`). The desk never gets a hidden `integrator` entry, and a later load with integration on migrates then.
  - **What it does.** On a match, sb appends `{ duty: "integrator", dutyFrom: null, dutyWhy: "migrated: <sign>", dutyAt }`, sets `s.duty`, rebriefs (a steer, if a run is going), and publishes.
  - **Sign 1: the name.** It matches `^integ \S+$`, the two-word form `integrator.md` prescribes (`integ <project>`).
    - It is checked at `session_start`, and in a `session_info_changed` handler (pi 1.3.0 `agent-session.js:3212-3216`, `types.d.ts:584-588`). That handler sees every rename as it happens: `boss_rename`, pi's `/name`, and other extensions.
    - It catches today's ledger integrators at their next start, and their takeovers at their rename.
    - The names in use, `integ FE2`, `integ v3`, and `integ insight`, match. Names such as `integ tests MP-1` and `integration notes` do not. Review 3's checks found no false match among the session names ever written on this machine.
    - **`boss_rename` says what happened.** When a rename migrates, its reply adds `Your kind is now integrator (migrated by name); boss_duty changes it.` When sign 1 matches but `s.duty` is already a declared other kind, it adds `Your kind stays <duty>; boss_duty integrator if you now run trains.` (AK6-F008).
  - **Sign 2: train todos.** The session's own branch holds a `train` todo (the rows `publish` reads). It is checked at `session_start` and at each `before_agent_start` before `briefing.begin`. It serves an integrator on trainboard trains.
  - **Both signs live in the session itself.** A name or a todo changes only that session's own prompt. A false match switches away with `boss_duty`, and stays switched.
  - **A rename away keeps the kind.** The entry holds the duty, so the duty belongs to the session (§6).
- **`dutyNow()`** returns `s.duty ?? "coordinator"`, except that it returns `coordinator` for `integrator` unless the train guard and the loaded prompts both have integration on (`trainOn && !prompts.off`).
  - **Why both reads count.** Both reads happen at the same extension load, milliseconds apart, so they can disagree only when a config edit lands between them. Checking both guards that race, so an integrator prompt never runs without its gate. With integration off, the check is also what hides `integrator`.
  - **Who reads it.** `boss_duty`'s enum and refusal, the briefing, presence, the gate, and the yard writer all read `dutyNow()`, so the label and the prompt cannot diverge.
- **The briefing.** `promptOf(role, dutyNow(), graph)` gives:
  - a coordinator: `main.md` alone, which is the coordinator's prompt;
  - an integrator: `main.md` plus `integrator.md`;
  - a standing main: `main.md` plus `duty-standing.md`;
  - the dispatch addenda after that: for a coordinator once it has a plan, for an integrator and a standing main always (§2a);
  - any other role: as today.

  `briefed` holds `role/duty/graph`, so a switch mid-run arrives as a steer.
- **Presence.**
  - Every publish carries `sb_duty: role() === "main" ? dutyNow() : null`, and `sb_duty: null` joins the clear list, so a demoted main leaves no stale value.
  - `whoAmI` treats a session as the integrator by its duty.
  - `whoMember` and `order.ts` `integratorTab` read the tab main's pane tokens (`sb_role=main`, `sb_duty=integrator`).
- **Why the sort reads a pane token.** This reverses TT-F002 (train-workers §23), which stopped a member from reading its main's pane tokens because any session can write them. The reversal is for display only.
  - The other sources are worse. The yard is fakeable (accepted for display in TT-F003) and absent for ledger integrators, and asking the server would add a route just for a sort order.
  - A forged `sb_duty` misplaces one sidebar row.
  - Phase 1 updates the three texts that say otherwise: train-workers §23, `src/order.ts:30-33`, and `src/presence.ts:39-40`.
- **The graph (D10).** It is read, never declared.
  - `Todo` gains `graph` (`graphOf(metadata.graph)`), and `TodoSum` gains `graph`.
  - **`planGraph(todos)`** in `src/todo.ts` is the one reader. It returns the graph of the open todo (`pending` or `in_progress`, not a train step) with the highest id that carries one, which is the newest plan, and otherwise nothing. `todoOfBranch` uses it for the card, and the briefing uses it for the prompt (§2a), so the label and the prompt cannot diverge (D6).
  - **No anchor fallback (AK6-F005).** An anchor is no sign of a plan, because pi-anchorloop anchors its own loop todos. planning.md now names a single loop's graph whenever a worker carries it (§9). A main carrying its work itself has no graph, and needs no dispatch rules.
  - **No plan.** With no open todo that names a graph, the card shows the kind word alone. A finished plan drops its graph on the next sum.
  - **The hub keeps it.** `todoOk` accepts `graph` only from `GRAPHS`, and the hub's rebuild (`src/dialogs.ts:145`) copies `graph` beside `done`, `total`, `now`, and `steps` (AK6-F004). From there it reaches `u.todo` (`src/ask.ts:130`).
  - **The page shows it for every main** (§11), not only for a coordinator, as the plan the main is running. For a coordinator it also selects the prompt (D14); for an integrator and a standing main it is shown only, since their prompt carries `dispatch.md` whatever the plan (AK6-F009, AK8-F001).
- **The yard and the gate.**
  - The guard's `env` gains `duty()`.
  - `publish` writes `yard.json` only while the duty is `integrator`, so a former integrator stops writing.
  - `integratorTodo` refuses a `train` todo for any other duty (§4). Ledger trains are not todos, so the gate never touches a ledger integrator's merges.
- **The net and the yard card.**
  - `net.ts` reads `sb_duty` only for `sb_role=main`, validated against `COORDINATOR_DUTIES`.
  - `YardJoin` (`src/train/yardview.ts:77`) gains `integrators`: the keys of mains whose `Unit.duty` is `integrator`.
  - `trainyard.ts:199` sets `integrator.key` for a writer in that set. It also sets it for a live main that publishes no `sb_duty` at all, which is a session still on an older sb during the upgrade window.
  - A writer that is a live main of another kind gets `integrator.switched: true`, and the card says it changed kind (`yard_integrator_switched`). A writer that is gone keeps `yard_integrator_gone`.
  - The three yard messages take the `kind_integrator` word as a parameter (`{kind}`), instead of hard-coding 整合員/Integrator: 「{kind}：已換種類」 / "{kind}: changed kind".
  - `integrators()` and `isIntegrator` lose their callers and are deleted, together with their test (`tests/train-tokens.test.ts:9-53`).

### 2a. Dispatch rules follow the plan (D14)

- **The plan counts once it names a graph.** That is `planGraph(own todos)` from §2, read in the main's own process from its branch (`todosOfBranch`), the same reader as the card's. A todo with `metadata.graph` but no open status does not count.
- **The prompt.** `promptOf(role, dutyNow(), graph)` gives a main:
  - **a coordinator:** `main.md`; once a graph exists, `dispatch.md`, then, for `fan-out/fan-in` or `orchestrator-worker`, that graph's addendum. `single-loop` has no addendum of its own: `dispatch.md` is all it adds (AK7-F008).
  - **an integrator or a standing main:** `main.md`, its kind's addendum, and `dispatch.md`, always, whatever its todos say. No graph addendum, and its graph never changes its prompt (AK8-F001, a decision of the sb main owner).

  **Why the two kinds differ.** An integrator and a standing main have no end and dispatch one-off workers all the time. Review 8 counted the last 7 days: `v1 redis ERR 排查` dispatched 278 workers and `CR9 切換` 60, and neither ever wrote a graph; `integ v3` dispatched 7 workers and `integ FE2` 1. Their kind is already their plan: a train or a watch. Gating them would cost a refused call and two uncached re-reads (in and out of a plan) for each one-off fix, on contexts of 100,000 tokens and up (AK3-F008.3). So `dispatch.md` is part of their kind's prompt instead.
- **What moves (cited lines at 27f86373):**

  | From | To |
  |---|---|
  | `main.md:3` split by owning app; worktrees; the worktree path | `dispatch.md` |
  | `main.md:4` "Dispatch work independent of your chain … not you" | `graph-fan-out.md` and `graph-orchestrator-worker.md` |
  | `main.md:4` "Before your first dispatch, plan by planning.md" | stays, as "Before you dispatch a worker, plan by planning.md" |
  | `planning.md` §5 "Run it" | `dispatch.md`, cut to one line |

  Everything else in `main.md` stays. That includes `:6`, the brief and its `caller_ping` ending, and `:7`, checking results and the boss's authorization, because a main with no plan still briefs scouts, planners, and reviewers (AK7-F001, AK7-F007).
- **Outside sb.** The boss's global AGENTS.md ("Model and dispatch") is in every main's system prompt too, and it carries dispatch rules: parallel dispatch, roles, `solutionSpace`, the reviewer after an anchor. D14 holds for sb's text. Aligning weihung-agent-root's `pi/AGENTS.md.in` is outside this spec; the boss may want it.
- **What a coordinator may dispatch with no plan.** The gate is the sb main owner's design choice, not a boss decision (D14 settles the prompts only). It applies to coordinator mains only. An integrator and a standing main are never gated, because they always carry `dispatch.md`.
  - **It passes:** `scout`, `planner`, the reviewer kinds (`reviewer`, `visual-tester`, `adversarial-reviewer`; `dutyOfAgent(agent) === "reviewer"`), and in phase 3 `watchdog` (AK7-F004). planning.md:13 says a review is a checkpoint, not a graph, so a reviewed loop, the review after a plan's last task, and an integrator's legacy train review all pass without one (AK7-F001).
  - **It refuses:** `worker`, any role `dutyOfAgent` does not know, and a bare or handoff spawn (no `agent`). These implement, which is what a plan governs. The refusal is in the existing `tool_call` handler (`src/session.ts:252-263`, which then takes `(event, ctx)`), after the promotion and only for a main whose `dutyNow()` is `coordinator`:
    `sb: plan first: a worker needs a plan whose todos name a graph (<dir>/planning.md). Write the plan's todos, then dispatch; a scout, a planner, or a reviewer may run now.`, where `<dir>` is the briefing's prompt folder.
  - **A plan in the same message (AK7-F002).** pi prepares every tool call of a message before any runs (pi-agent-core `agent-loop.js:411-450`), so a `todo` call beside the `subagent` call has not yet written its state. The gate therefore also reads the newest assistant message on the branch (`ctx.sessionManager.getBranch()`). It takes the `todo` calls that come before this `subagent` call, and passes if one of them names a known graph in `metadata`: `create` with `metadata`, `create` with `tasks[].metadata`, or `update` with `metadata`.
    - **Why the message is there (AK8-F005, pinned pi 1.3.0).** `streamAssistantResponse` awaits `emit(message_end)` before it returns (pi-agent-core `agent-loop.js:319`, `:332`), and tool execution runs after (`:141`, `:165`). `Agent.processEvents` awaits each listener (`agent.js:432-433`), and `AgentSession` appends the message on `message_end` (`agent-session.js:756-760`). The `tool_call` event itself carries no message (`types.d.ts:931-941`), so the branch read is the only way.
    - **Edges.** A codemode call (`parentToolCallId` set) is in no message, so it is judged by state alone: a script that awaits `todo` before `subagent` passes, and one that runs both in `Promise.all` is refused. An earlier `todo` call that later fails validation still counts; the plan it meant is missing, which the next turn shows.
    - If pi ever stops appending the message before tools run, the phase 1 test against pinned pi fails, and the refusal text above still says what to do.
  - `subagent_resume` is not refused: it continues a dispatch already made. A train is not a main, and members are not covered.
  - **Why a block, given the prompt.** The block keeps implementation behind a plan: the `subagent` tool is in every main's tool list, and without the block a main could hand a worker a task that no plan's anchors and checkpoints cover (AK7-F007).
- **Rebrief.** `briefed` holds `role/duty/graph`; the graph part is empty for an integrator and a standing main. The graph is read again at each `before_agent_start` and after each `todo` tool result. A change during a run arrives as one steer that names what changed, instead of the role steer's "Your Straw Boss role changed" (`src/briefing.ts:26`), which would be false here (AK7-F008):
  - a graph appears: `Your plan's graph is now <g>. Add to your instructions:` followed by `dispatch.md` and the graph's addendum;
  - the graph changes: `Your plan's graph is now <g>. Replace your "## Graph:" section with:` followed by the new addendum, or `Drop your "## Graph:" section.` for `single-loop`;
  - the plan ends: `Your plan has no open graph: drop your "## Dispatch" and "## Graph:" sections.`

  A steer carries only what was added (about 600 characters at most), not the whole prompt.
  - **Cost.** For a coordinator, the next run's system prompt differs, so it re-reads its whole context once, uncached. That happens when a plan first names a graph, when a replan changes it, and when a plan ends. A review dispatched after the plan has ended needs no plan, so it costs no flip. An integrator or a standing main never flips on its graph.
- **The release note** says: a coordinator main that dispatches a `worker` must first write a plan whose todos name a graph. Scouts, planners, and reviewers need none, and integrators and standing mains are never asked. The first refused call says how.

### 3. `boss_duty` (D2)

The tool is registered beside `boss_rename` (`src/tools.ts:129`). The kind definitions live only in its description. When `dutyNow`'s rule would hide `integrator`, it is left out of both the enum and the description.

```
boss_duty({ duty: "coordinator" | "integrator" | "standing", reason: string })
"Your kind; your role prompt's addendum follows it, and the next run re-reads its whole context once. coordinator (the default): plans and dispatches; your todos' graph shows its shape. integrator: a project's merge trains. standing: one system or machine, no end. reason: one line, why now."
```

The phrase "re-reads its whole context once" tells the model a switch has a cost. A switch changes the system prompt, so the next turn reads the whole context without the cache. Integrator turns here read 100,000 to 420,000 tokens (AK3-F008.3).

| Caller | Result |
|---|---|
| main | Switches, in this order: (1) the entry, with all four fields; (2) `s.duty`; (3) phase 2: `roles.remember("main")`; (4) rebrief; (5) publish; (6) `digest.note(workspace, "<name> kind <from>→<to>: <reason>")`. Reply: `Your kind is now <to> (was <from or none>).` |
| main, same duty | `Your kind is already <duty>`, when `s.duty` already holds it; nothing is written. A main with no declared duty may declare `coordinator`, which writes the entry and so ends the migration's chance (§2). |
| main, `integrator` hidden by `dutyNow`'s rule | Not in the enum. A raw call gets `Integration is off on this computer: no integrator`. |
| main, away from `integrator` with `train` todos `pending` or `in_progress` | `<n> of your trains are forming or departing: depart or return them first`. Ledger trains are not seen, so a ledger integrator can switch away mid-train; the release note says the boss or the tower then hands its trains on. |
| main, in a Straw Link remote turn | `A teammate's turn cannot change this main's kind`. |
| member | `Only a tab's main agent has a kind; call boss_promote first if your work grows`. |
| train | `A train's kind is fixed: train`. |
| tower, tower run, head | Not registered. |
| pi-herdr-agents child | Not registered. Its kind is fixed at spawn (D4). |

`reason` is required, collapsed to one line (`plain()`), and at most 200 characters.

### 4. The integrator

- **The gate.** A `train` todo needs `dutyNow() === "integrator"`. Otherwise the guard refuses it: `sb: a train todo is the integrator's: call boss_duty with duty "integrator" first`.
  - The gate covers `train` todos only. Ledger merges and deploys are never gated.
  - **Takeovers.** A takeover runs `main.md` alone only until its rename (§2). In that window, `main.md`'s integration line forbids merges unless its kind is `integrator`, which is stricter than today's line ("the project's integrator (integrator.md)"). Review 3's data puts the window at 1 to 3 minutes, before any merge, so the stricter rule costs nothing.
- **`integrator.md` becomes the integrator's addendum.** Its "apps-config.md beside this file" becomes `{{dir}}/apps-config.md`. The rest of it is unchanged.
- **Prompt edits elsewhere.**
  - `tower-run.md`'s open request becomes "you are <project>'s integrator: call `boss_duty` with `integrator` first". Phase 2 passes `duty` instead (§6).
  - `main.md`'s integration line says "unless your kind is `integrator`" instead of naming integrator.md.
- **One integrator per project** stays a prompt rule.
- **The release note** tells the boss two things:
  - integrators, and takeovers once they rename, get their kind from a name of the form `integ <project>`; any other integrator calls `boss_duty integrator`;
  - switching away mid-train leaves ledger trains without an integrator.

### 5. Defaults

- A main with no declared duty is a `coordinator`: it runs `main.md` alone and shows 協調者, with its plan's graph when it has one.
- It switches only when its work becomes a project's trains or a standing watch. Nothing asks it to declare.
- A member auto-promoted by its first `subagent` call becomes a coordinator the same way.

### 6. Hand-overs, copies, and the opener

- **The duty belongs to the session.** A tab's new main has its own duty or none. A demoted main publishes `null`, and its duty comes back if it is promoted again.
- **Copies.** `/fork` and `/clone` copy the duty with the entries. `/new` starts with none.
- **pi-intercom's `handover`** passes a summary. The receiver keeps its own kind.
- **`boss_open_main` gains an optional `duty`** (phase 2).
  - The opener writes `sb_open_duty` beside `sb_open_main`, and `claimOpened` consumes both.
  - `claimOpened` sets `s.duty`, writes `RoleRecord.duty` (as `openedBy` is written), and appends `{ duty, dutyFrom: null, dutyWhy: "opened by tower <name> as <duty>", dutyAt }`.
  - The record covers a restore before the first message, when pi has persisted no entry yet. Restore reads `s.saved.duty ?? record.duty` when `held()` says main.
  - The promotion that follows rebriefs (`src/membership.ts:77`).

### 7. Restore after a Herdr restart

The restore resumes the pane into its session file, in a new process. Then:

1. `session_start` reads the duty from the entries, or from the record (phase 2), and checks the migration signs.
2. The role comes back through its record.
3. Presence writes `sb_duty` at once (`src/presence.ts:100-106`).

Nothing depends on a pid.

### 8. Worker kinds: linked by session file (phase 2)

The child's **session file** is what ties a resumed child to its kind and its parent, because a resume has a new id and a script with no role (AK3-F002).

- **The child records its role.** Each child's sb appends `straw-boss { agent: <PI_SUBAGENT_AGENT> }` at its first `turn_start`. pi keeps the entry in memory and writes it with the task message.
  - The entry is written only when the variable is set and the session has no such entry yet. A resume keeps the file, so it keeps the entry.
  - **The first `{ agent }` entry wins.** A child with `bash` or `write` could append another, but that would only mislabel itself.
- **The net links a resumed child (AK4-F002).**
  - When no `-<id>.sh` script exists, `subagents()` takes the script in `subagent-scripts/` that carries `PI_SUBAGENT_ID='<id>'`. `scriptRead` also parses the id, still cached by mtime.
  - The row's `file` comes from that script's `PI_SUBAGENT_SESSION`, and its pane is the one whose `agent_session.value` is that file.
  - This also fixes the bug where a running resumed child shows as `done` with a hex name.
- **The net reads the role.** It reads the role from the first `{ agent }` entry in the row's `file`. It reads at most the first 64 KB: AK4 found the entry within the first 30 KB of all 1,533 child sessions sampled. A role, once found, is cached by path.
  - Until the entry exists, a first-launch script that carries `PI_SUBAGENT_AGENT` for that session stands in for it.
  - `subsOf` sets `Unit.duty = dutyOfAgent(agent)`. The raw name never reaches the page.
- **Why the label follows the prompt.** pi-herdr-agents resolves the role name to one definition, and fails the launch for a missing name.
- **Limits.**
  - A handoff launch and a bare spawn have no role, so they show as a plain subagent.
  - The script format is internal to pi-herdr-agents.
- **Upstream asks (todo #49).**
  1. The role and its frontmatter `kind` in the activity file.
  2. `PI_SUBAGENT_AGENT` on resume.
  3. The child's name on intercom.

### 9. Kind prompts, context, tools, the user (D6, D7, D8)

**Where the prompts live.**

- **Coordinator addenda** are sb's: `prompts/duty-standing.md` and `integrator.md`. A coordinator has none.
- **Dispatch addenda** are sb's too (§2a): `prompts/dispatch.md`, `prompts/graph-fan-out.md`, and `prompts/graph-orchestrator-worker.md`.
- **Worker kinds are sb's role pack (D11; phase 2).** `roles/` in this repo holds `worker`, `scout`, `planner`, `reviewer`, `visual-tester`, `adversarial-reviewer`, and, in phase 3, `watchdog`.
  - **Registration.** A small extension, `src/rolepack.ts`, is added to `pi.extensions`. It registers `roles/` on `pi-herdr-subagents:roles:discover:v1` and unsubscribes at `session_shutdown`, as `docs/roles.md` prescribes. It runs in every pi, Herdr or not and child or not, because a child that spawns (planner, adversarial-reviewer) resolves roles too. `roles` joins `files` in `package.json`.
  - **What each role starts from.** The five roles that have an override start from that override, with everything it carries (listed in "What sb has today"). `planner` starts from pi-herdr-roles 0.1.0 `roles/planner.md`. Each then gains its `tools:` line, its brief fields, and its `show_doc` line from the table below.
  - **Attribution (AK6-F006).** `NOTICE.md` gains a section "Role definitions (`roles/`)" that:
    - reproduces verbatim the MIT notice pi-herdr-roles 0.1.0 carries (`LICENSE`: "Copyright (c) 2026 HazAT"), with its lineage line from `THIRD_PARTY_NOTICES.md`: moved from giuseppecrj/pi-herdr-agents at `c2177dff`, from HazAT/pi-interactive-subagents and 0xRichardH/pi-herdr-subagents;
    - names the files derived from weihung-basic-agent's overrides (MIT, "Copyright (c) 2026 wayne930242"): `worker`, `scout`, `reviewer`, `visual-tester`, `adversarial-reviewer`;
    - names `planner` as derived from pi-herdr-roles alone.
  - **Who keeps them.** pi-herdr-roles is no longer read, so nothing upstream can change these roles. A change to a role is an sb change, released with sb.
  - **The migration** is in phase 2, in two weihung-basic-agent commits, so that no live session is ever left without roles (AK6-F001).
  - **`/plan`.** It leaves with pi-herdr-roles, together with the `plan` skill (D15, Q9 「讓它們消失」). A main plans by `planning.md` and dispatches `planner` directly.
- **The train** is `prompts/train.md`.

**Preloaded context** comes from three places: sb's rendered section (`{{tab}}`, `{{tower}}`, `{{state}}`, `{{cli}}`, `{{dir}}`), static lines in the role prompt, and the brief fields the role prompt names.

| Kind | Prompt | Preloaded context | Tools | The user | Reports to |
|---|---|---|---|---|---|
| coordinator | `main.md`; with a plan, + `dispatch.md` + its graph's addendum (§2a) | sb's main section; planning.md | Full | As `main.md`: questions for undecided points; `show_doc` for what the boss confirms | Boss; tower |
| integrator | `main.md` + `integrator.md` + `dispatch.md`, always (§2a) | Same, plus `{{state}}/trains`, `{{cli}} train check` | Full | Asks no one; `call_tower` `blocked` | Tower; the sb server sends car notices |
| standing | `main.md` + `duty-standing.md` + `dispatch.md`, always (§2a) | Same | Full | No question dialog: it reaches the boss only as the tower's wait card, through `call_tower` `blocked`; the tower run decides whether to write one (D12, AK6-F012). Under auto mode it never waits (todo #140) | Board line; tower |
| worker | role `worker` | Brief: goal, anchor, authorizations, worktree | **Full** (no `tools:`) | None; `caller_ping` for an undecided point | Dispatcher |
| scout | role `scout` | Brief: question, paths, codebase-memory project | `read, grep, find, ls, bash, mcp` | None | Dispatcher |
| planner | role `planner` | Brief: plan path, scout material | `read, grep, find, ls, bash, write, edit, subagent, ask_user_question, show_doc, mcp` (`edit` added so it revises a plan in place, AK6-F011) | One compact question set; `show_doc` for a plan to confirm | Dispatcher |
| reviewer: code | role `reviewer` | Brief: `base..head`, spec or brief, anchor result | `read, grep, find, ls, bash, write, show_doc` | `show_doc` the HTML page when the brief says the boss reads it | Dispatcher, P0/P1 first |
| reviewer: visual | role `visual-tester` | Brief: URLs, viewports, login route; role prompt: the Playwriter session convention | `read, write, bash, show_doc, ask_user_question, find_roots, observe_ui, act_ui, inspect_ui, search_ui, expand_ui, read_text, wait_for, launch_browser, navigate_browser, evaluate_browser` | Asks before any state change; `show_doc` an HTML page with screenshots | Dispatcher, with the page path |
| reviewer: adversarial | role `adversarial-reviewer` | Brief | No `tools:` line, so every tool, as the override has it today (AK6-F011) | None | Dispatcher |
| watchdog | role `watchdog` (sb's pack, phase 3) | Role prompt: which replies to report. `watch_read`'s description: the reply. Brief: target key, `quietMs`, `loadMax`, time limit | `read, watch_read, watch_report`; D3 held by sb (§10) | None | Dispatcher, only via `watch_report` |
| train | `prompts/train.md` | Manifest and Seam bindings | Full; its guard holds `todo` and `MonitorCreate` | None | Tower; car notices |

**What the tool lists do and do not hold.**

- A dispatcher's spawn `tools` can widen any of these lists. That is accepted for the read and review kinds, whose lists exist for cost and focus. For the watchdog, sb holds D3 itself (§10).
- `bash` is no boundary, as pi-herdr-agents' own README says.
- `mcp` reaches every configured MCP server (Q6).

**Drafts.** Each says only what differs from its base.

`main.md`: six lines change (two of them in the Seam bindings) and one moves out (§2a), so the file goes from 29 lines to 28. These are the exact texts the D7 measurement below was taken on.

```diff
-You are the main agent of Herdr tab {{tab}}: the boss works with you here. Your workspace tower is {{tower}}.
+You are the main agent of Herdr tab {{tab}}, of kind {{duty}}: the boss works with you here. Your workspace tower is {{tower}}.
-- Split work by owning app ({{dir}}/apps-config.md). A task is one worker's end-to-end work in one app; parallel writers get worktrees; dependent tasks wait. A hand-made worktree goes under `~/.herdr/worktrees/<repo>/<branch>`: elsewhere a child hangs on pi's trust prompt.
-- Before your first dispatch, plan by {{dir}}/planning.md. Dispatch work independent of your chain to a subagent in parallel; "carry bounded work yourself" binds a single loop, not you.
+- Before you dispatch a worker, plan by {{dir}}/planning.md.
-- For an app with `integration` (apps-config), never merge to its base or claim a pre-dev branch, unless you are the project's integrator ({{dir}}/integrator.md); else …
+- For an app with `integration` (apps-config), never merge to its base or claim a pre-dev branch, unless your kind is `integrator`; else …
-- When your work turns to another task, `boss_rename` yourself.
+- When your work turns to another task, `boss_rename` yourself; `boss_duty` when your kind changes.
-- Handoff route: the coordinator sends the car slip …
+- Handoff route: the slip's sender sends the car slip …
-- Approval: the boss. The coordinator quotes in `auth` …
+- Approval: the boss. The sender quotes in `auth` …
```

- `:6` (the brief) and `:7` (check results; the boss's authorization) stay as they are (§2a).
- `{{duty}}` renders the kind word in English (`coordinator`, `integrator`, `standing`), so the prompt states the kind that `boss_duty` changes (AK6-F008).
- `integrator.md` and `train.md` say "the slip's sender" the same way (§1): `integrator.md:3` "places its coordinators' cars" becomes "places the cars mains send it"; `:8` and `train.md:13` "never send a coordinator a notice" become "never send a slip's sender a notice"; `:12` "intercom to its coordinators" becomes "intercom to the slips' senders". The field name in `integrator.md:6` and `train.md:17` stays.

A coordinator has no kind addendum: `main.md` with `planning.md` is the coordinator's prompt.

`prompts/dispatch.md` (§2a): `main.md:3` verbatim, and planning.md §5 cut to one line.

```
## Dispatch
- Split work by owning app ({{dir}}/apps-config.md). A task is one worker's end-to-end work in one app; parallel writers get worktrees; dependent tasks wait. A hand-made worktree goes under `~/.herdr/worktrees/<repo>/<branch>`: elsewhere a child hangs on pi's trust prompt.
- When a result passes its brief and anchor, mark its todo `completed` and dispatch what it unblocked. A failed or cancelled task leaves its dependents blocked: report them, and resolve the next step with the boss.
```

There is no `graph-single-loop.md`: a header alone would change nothing the model does (AK7-F008).

`prompts/graph-fan-out.md` and `prompts/graph-orchestrator-worker.md` carry the same line under their own header. They never run together, so no prompt holds it twice.

```
## Graph: fan-out/fan-in
- Dispatch work independent of your chain to a subagent in parallel; "carry bounded work yourself" binds a single loop, not you.
```

`planning.md`:

- §1's opening line, `planning.md:3`: "Plan before your first dispatch, and again when the work's shape changes." becomes "Plan before you dispatch a worker, and again when the work's shape changes." (AK8-F004).
- §1, single-loop: "Do not state it; its plan is one todo whose `metadata.anchor` names its check." becomes "Its plan is one todo whose `metadata.anchor` names its check, plus `"graph": "single-loop"` when a worker carries it."
- §2: `"graph": "..."` becomes `"graph": "<a §1 name, exactly>"`; §1 spells the three tokens (AK6-F005).
- §5 "Run it" moves to `dispatch.md`.

`prompts/duty-standing.md`. Auto mode (todo #140) adds its own rule; this draft does not anticipate it. Phase 3 adds "or a `watchdog` subagent" to its watch line.

```
## Kind: standing
Your main prompt's `Done when` and done report do not apply.
- Your board line names what you mind and its state now.
- Watch with `MonitorCreate`, not by checking in your own turns.
- A question for the boss is `call_tower` `why: blocked`, never a question dialog: nobody may be at your pane.
- Work that grows into a requirement: `call_tower` `why: blocked` naming it, for a new main.
```

`roles/watchdog.md` in sb's pack (phase 3):

```
---
name: watchdog
description: Watches one unit of the straw net (tests, a deploy, a train, another agent) and reports anomalies to the coordinator that dispatched it
tools: read, watch_read, watch_report
spawning: false
auto-exit: true
system-prompt: append
---

# Watchdog

Watch the unit your task names: call `watch_read` with the last `since` and the task's `quietMs` and `loadMax`, again after each reply, until the unit's work ends, the task's time limit passes, or a reply is `gone`.

- Report with `watch_report`, once per finding: a `stalled` or `load` reply; a `changed` reply whose `mark` is `waiting` or `error`, or whose monitor is `error` or `stale`. Say what, since when, and the fields that show it.
- `watch_report` replying `gone` (your dispatcher ended): end.
- End with a summary of what you reported.
```

**Acceptance for D7.** The test is `tests/duty-prompts.test.ts`: the addenda in phase 1, the role files from phase 2.

- **Repeats, per composed prompt.** For every role × kind × graph, the prompt `promptOf` builds holds no sentence twice after normalization. Its addenda also repeat no sentence of `planning.md` or of `boss_duty`'s description. A role file repeats no sentence within itself.
- **Size.**
  - A new kind addendum is at most 6 lines and 900 characters. A graph addendum is at most 2 lines and 300 characters.
  - `integrator.md` and `dispatch.md` are exempt by name, because both are text moved, not written. They are pinned at 14 and 3 lines, and the repeat check still applies to both.
  - **No growth from the move (AK7-F003).** `main.md` + `dispatch.md` + `planning.md` together are shorter, in characters, than `main.md` + `planning.md` at 27f86373. Measured on the drafts above, with the trailing newline of each file counted:

    | | Characters |
    |---|---|
    | `main.md` + `planning.md` at 27f86373 | 5,297 + 4,379 = 9,676 |
    | new `main.md` + `dispatch.md` + `planning.md` | 4,918 + 501 + 4,162 = 9,581 |
    | **difference** | **−95** |

    What a main runs per turn, against today's `main.md` (5,297):

    | Main | Section | Characters | Against today |
    |---|---|---|---|
    | coordinator, no plan | `main.md` | 4,918 | −379 |
    | coordinator, `single-loop` | + `dispatch.md` | 5,419 | +122 |
    | coordinator, `fan-out/fan-in` | + `dispatch.md` + its graph line | 5,573 | +276 |
    | coordinator, `orchestrator-worker` | the same, with a longer header | 5,578 | +281 (AK8-F003) |
    | integrator | `main.md` + `integrator.md` (3,275) + `dispatch.md` | 8,694 | +3,397; today it reads `integrator.md` (3,280) into its context once, as a file, which gives 8,577 in all |
    | standing | `main.md` + `duty-standing.md` (405) + `dispatch.md` | 5,824 | +527 |

    A plan adds the dispatch rules and, for two graphs, the graph line. The no-plan prompt is shorter by the lines that moved. The integrator's figure is larger only because `integrator.md` becomes a system-prompt section, which is cached, instead of a file read once per session.
- **`main.md`** stays at 28 lines or fewer.
- **Role files** stay at or under the line count each has at the pack's first release, which the test pins.
- **What a reviewer still checks.** The machine check catches verbatim repeats only. A reviewer reads for paraphrased repeats and for lines that fail the no-op test.

**Acceptance for the tool sets (AK6-F002, AK6-F003).** The check runs in a live session; no probe process is started.

- **The command.** `/boss roles-check [folder]` runs in a top-level pi session in a Herdr pane, before each release that changes `roles/`. `/boss` is registered after the child return (`src/index.ts:83`, after `:62`), and sb returns outside Herdr (`:51`), so a child and a pi outside Herdr have no such command (AK8-F006).
  - **A narrowed session refuses.** `getAllTools()` honours `--tools` and `--exclude-tools` in any process (`agent-session.js:1123-1129`), so a session started with either would fail falsely. When `process.argv` holds `--tools` or `--exclude-tools` (alone or as `--flag=…`), the command answers `roles-check needs a session started without --tools or --exclude-tools` and checks nothing.
- **What it compares.** It reads the role files in the folder given, or by default in the `roles/` of the sb package it runs from. Before a release, the checkout's folder is named explicitly (`/boss roles-check ~/projects/pi-straw-boss/roles`), so a checkout is checked without loading a second sb. It compares each `tools:` name with `pi.getAllTools()` (pi 1.3.0 `types.d.ts:1284`), plus the child-only names and their source:
  - `caller_ping`, and `subagent_done` for a role that does not auto-exit: pi-herdr-agents' child extension (`launch.ts:762`, `launch-command.ts:67`);
  - `watch_read` and `watch_report`: sb, registered only in a child (`if (env.PI_SUBAGENT_ID)`, §10).
- **Why it touches nothing live.** It is one command in a session that already runs. No new pi starts, so nothing joins Herdr, registers with intercom, starts an sb server, or needs packages or auth.
- **Parent-only names fail.** A role that lists a tool a child never has fails, with the reason. The list has two parts:
  - **sb's own:** an exported constant `PARENT_ONLY` in `src/tools.ts`, the names of every tool sb registers after the child return (`src/index.ts:62`). sb has no registry of its names today (its `registerTool` calls are in `src/tools.ts`, `src/traincar.ts`, `src/runmode.ts`, and `src/runhead.ts`), so a test registers sb's extension against a recording `pi` with and without `PI_SUBAGENT_ID`. The names that appear only without it must equal `PARENT_ONLY`.
  - **pi-herdr-agents' worktree tools,** which take `parentSession` (`index.ts:379`, `:495`), listed by name with that citation.
- **Pass.** Every name resolves, and none is parent-only. The report lists each role's names with where each comes from.
- **What it still cannot see.** Another extension that registers a tool only outside a child would pass here. The first live dispatch of each role after a release confirms it, from the pi-herdr-agents widget's tool count.
- **Its logic is tested in `npm test`.** `rolesCheck(roleFiles, toolNames, childOnly, parentOnly)` is a pure function with fixtures.

### 10. The watchdog (D3; phase 3)

**`watch_read({ key, since?, waitMs?, deadline?, quietMs?, loadMax? })`**

- **Request.**
  - `key`: a unit key or session id of this computer's net.
  - `since`: the stamp from the last reply.
  - `waitMs`: default 600000, at most 3000000 (50 minutes), so a turn is well inside the prompt cache's life of about an hour (AK3-F004).
  - `deadline`: an absolute time in ms, which the brief gives. At it the reply is `expired`. Every reply carries `now`, so a watchdog with no `bash` still knows the time.
  - `quietMs`: at least 60000.
  - `loadMax`: defaults to each monitor's `load.max`.
- **What wakes it.** Only state wakes it: the unit's `mark`, a monitor's `status` or `exit`, todo progress, a train's step, status, and waits, and `gone`.
  - Output lines, `Monitor.last`, `lines`, `at`, `note`, `ticks`, and load readings never wake it.
- **What the server judges.** The stamp records what was already returned, so each verdict comes once.
  - **`stalled`:** no tick and no monitor line for `quietMs`. It is returned once until the unit moves again.
    - After a reading gap longer than `GAP_MS` (60 s, a sleeping Mac; `src/activity.ts:3-8`), the quiet clock restarts, as the activity tracker does.
    - For a subagent target, only mark and note exist (`src/net.ts:121-124`), so its clock moves on mark and note changes (`src/activity.ts:35-36`).
  - **`load`:** a monitor's `load.now` crosses `loadMax`. It is returned once until the load falls back under.
    - Only monitors whose newest line is a progress line with `load` carry one (`src/monitors.ts:5-10`); in practice that is a train's gate wrapper. A test or deploy monitor never gives `load`.
- **Reply.** `{ state: "changed" | "stalled" | "load" | "unchanged" | "expired" | "gone", since, now, unit? }`.
  - `unit` holds `mark`, `note`, `todo`, and, per monitor, its status, exit, last line, load, and age. For a train it also holds the step and waits, and it holds the subagents' marks.
  - It carries no transcript and no path.
  - `gone` carries the successor key (`src/net.ts:88`).
- **One server hold.** It is at most 45 s, by the hold's own timer, which answers with the last reading and waits for no further one. That fits inside the control socket's 60 s idle close, which counts from the request's arrival (`src/server/socket.ts:20`, `:89`). `socket.ts` is unchanged.
  - The client's request timeout is 55 s.
  - A hold whose client has gone ends at its 45 s limit.
  - There is no cap and no refusal. A hold costs one stamp compare per net reading. The readings are the GUI host's (every 2 s while a page is open, every 10 s otherwise); while the GUI is off, the route reads the net itself every 10 s, only while a hold is open (2026-11-14 note, 1).
- **The tool's loop.** Inside one `execute`, the tool re-polls until `waitMs` passes or the reply is anything but `unchanged`, each time with the newest `since` an `unchanged` reply gave (2026-11-14 note, 2).
  - **On each re-poll it calls `onUpdate`.** That moves the activity file's `updatedAt`, so pi-herdr-agents' hang advisory never fires. The boss's `hangWarningMinutes` is 15, and a silent hold would trip it (`observation.ts:157-223`).
  - **It returns `unchanged` early only for a message that arrives during the call.** That is, `ctx.hasPendingMessages()` turned true after being false when the call started. A steer is consumed at the turn boundary before the next call, so a message already pending at the start is a follow-up: it waits, and the loop does not spin (AK4-F005). A dispatcher's steer or `subagent_send` lands within one hold, at most 45 s; while the server does not answer, within one 2 s retry.
  - **A failed hold is retried.** A server restart or upgrade (`socket.ts:40`), a socket error, or a request cut off by a sleep is retried after 2 s. The loop keeps retrying within `waitMs`, and `waitMs` and `deadline` are judged by the wall clock, so a sleep counts. If the server is still unreachable when `waitMs` ends, the reply is `unchanged` with `server: "unreachable"`.
  - **Only two things fail the call:** an unknown key, and an abort.
- **Token cost.** These are estimates, assuming a reply of about 300 tokens, a call of about 80, and a cached context. That holds while `waitMs` stays under the cache's life of about an hour (AK3-F004, measured on claude-bridge).
  - A quiet target costs about 6 turns an hour at the default `waitMs`, and adds about 2,000 tokens of context an hour.
  - A busy target (monitors starting and ending, todos completing, steps moving) costs 10 to 30 turns an hour, and adds 4,000 to 12,000 tokens an hour.

**`watch_report({ text })`**

- **The child sends.** The child's sb calls `watch-report { session: PI_SUBAGENT_SESSION, child: PI_SUBAGENT_ID, activityFile: PI_SUBAGENT_ACTIVITY_FILE, text }`. The launch script sets all three variables, and so does the resume script.
- **The server checks** (AK3-F002, linking by session file):
  1. The activity file is a real file under pi's sessions folder, `<parent artifacts>/subagent-activity/<child>.json`, and does not say `done`. The parent session id is that `artifacts/<id>` folder. The session path is under pi's sessions folder too. It may not exist yet, because pi writes it with the first message (AK4-F003); in that case it is accepted only when check 2's script names it and carries `PI_SUBAGENT_AGENT='watchdog'`.
  2. A script in the same `subagent-scripts` folder (a launch script or a `-resume-` one) carries `PI_SUBAGENT_ID='<child>'` and names that session file.
  3. The session file holds sb's `{ agent: "watchdog" }` entry (§8), or, before the entry exists, a launch script for that session carries `PI_SUBAGENT_AGENT='watchdog'`.
- **What the check cannot do.** It cannot authenticate the caller, because the control socket has no peer credentials (train-workers §24). Any same-user process with `bash` can send a report in a watchdog's name to that watchdog's parent. The harm is a false message. The watchdog itself cannot forge its parent: it has no `bash`, and its environment is fixed.
- **Delivery.** The server sends one intercom message to the parent, under a code-written header with the new `Kind` `watch_report` (`src/header.ts:12`) and `reply=none`.
  - `from` is `{ name: "watchdog <child name>", id: <child id>, role: "session" }`.
  - This is the same path car notices take (`src/server/carnotices.ts`).
- **Reply to the tool.** `delivered`, `queued`, or `gone`. `gone` means the dispatcher ended.
- **Limits.** `text` is 1 to 2000 plain characters, at most one report every 30 s, no repeat of the same text, and no target parameter.

**Holding D3.**

- **Registration.** sb registers both tools under `if (env.PI_SUBAGENT_ID)`, with `defaultActive: false`, before the return for a session outside Herdr (`registerWatchdog` in `src/index.ts`; 2026-11-14 note, 3), so a top-level pane never has them (AK8-F006) and a Core-launched child, which has no pane, does. In a child they are active only where `--tools` names them.
- **Which child is a watchdog.** At `session_start`, either of these makes a child a watchdog:
  - `PI_SUBAGENT_AGENT=watchdog` (a first launch);
  - its session's `{ agent: "watchdog" }` entry (it survives a resume, which restores the spawn's `--tools` anyway, `launch-resume.ts:136-147`).

  A child's tool list is not a sign (AK4-F006.k): a scout spawned with `watch_read` in its `tools` stays a scout, unnarrowed.
- **The boundary is the `tool_call` block.** It blocks every tool outside `read, watch_read, watch_report, caller_ping, subagent_done` with `sb: a watchdog only reads and reports`.
  - It holds whatever a spawn or resume passed, and codemode calls go through it too (`types.d.ts:262-280`).
  - `setActiveTools()` narrowing is cosmetic: it keeps the model's view small. It is applied at every `before_agent_start`, because each late `registerTool` re-widens the set (AK3-F006).
- **A watchdog that cannot watch.** pi keeps unlisted extension tools out of the registry, so a watchdog whose allowlist lacks `watch_read` or `watch_report` (a spawn `tools` override) cannot watch. sb handles it at the first `before_agent_start`, by which point every `session_start` handler has run, pi-herdr-agents' activity file included (AK4-F003):
  1. it sends the dispatcher `sb: watchdog <name> cannot start: its tool list lacks watch_read/watch_report (a spawn tools override?)` through `watch-report`, which check 1 accepts before the session file exists;
  2. it calls `ctx.abort()` and `ctx.shutdown()`;
  3. it returns a `systemPrompt` that asks for an empty reply, so if pi starts the run anyway, it is one short turn whose tools are all blocked.
- **No escape.** A process with `bash` already reaches the socket and every session file, so passing itself off as a watchdog gains it nothing.

**2026-11-14 (0.80.0): as built.** Where this section and the code differed, the code stands; [how it works](../how-it-works.md#the-watchdog) describes it in full.

1. **Readings.** The server reads the net only while the GUI host runs. With the GUI stopped, or never started, the route makes its own reading every 10 s, only while a hold is open, and a request whose last reading is 20 s old or older reads once before it is judged. When no reading can be made the reply is the error `the net could not be read; ask again`, which the tool retries as a failed hold.
2. **`since` on a re-poll.** The tool sends the newest `since` the server gave, not the call's own. An `unchanged` reply's stamp can differ from the request's: a load that fell back under its limit is forgotten in it. Sent again, the old stamp would hide that monitor's next crossing.
3. **Registration.** `registerWatchdog` runs for every `PI_SUBAGENT_ID` before the `HERDR_PANE_ID` return, so a child of pi-herdr-agents' Core backend is held by D3 too. Outside Herdr a first-launch watchdog also writes its `{ agent: "watchdog" }` entry there, so its resume is still known.
4. **Verdict order.** One reading gives one verdict, in this order: `gone`, `expired`, `changed`, `load`, `stalled`. `changed` does not count a load as told, so a load already over the limit at the first call comes as `load` on the next.
5. **`stalled` is judged on readings.** The quiet spell is the last reading less the start of the quiet, not the wall clock: with no reading nothing is claimed. A move seen across a reading gap is a move, so a `stalled` told before it comes again.
6. **Keys.** A key the registry knows that is no unit of the net (the head tower, a run's read-only view) is `unknown key` after one more reading. A unit that leaves mid-hold with no trace in the registry is `gone` with no successor.
7. **A failed hold.** Any `ok: false` reply but `unknown key` is retried every 2 s; at `waitMs` the reply is `unchanged` with `server: "unreachable"` and the server's `error`, or `server: "outdated"` for a server older than 0.80.0. A deadline that passes with no answer gives `expired` with `server`. The request's timeout is the lesser of 55 s and the time left. An `unchanged` that comes back in under 2 s is followed by a 2 s pause. An abort ends the call at once. A message that arrives during the call ends it at the next retry as well as at the next hold.
8. **`watch_report`.** One attempt with a 10 s timeout. With no answer in time the report may or may not have been delivered, and the tool says so: a `rate` or `same text` refusal of the same text sent again means it went out. More errors than the list above: `pi-intercom is not connected`, `pi-intercom cannot list its sessions: …`, `not delivered: …`, and `text is 1 to 2000 plain characters` (plain: no control or format character but a line break or a tab). The checks run in the order outside, no tying script, done, not a watchdog, rate, repeat. Only a report that went out counts for the rate and the repeat; of two sent at once, the second meets the rate.
9. **A blind watchdog.** On a second reply in a row that carries `server`, the role has the watchdog tell its dispatcher once with `caller_ping`, which does not go through the sb server, and keep calling.

### 11. The page (D9)

- **Words.**
  - The base messages gain `kind_coordinator`, `kind_integrator`, `kind_standing`, `kind_worker`, `kind_scout`, `kind_planner`, `kind_reviewer`, and `kind_watchdog`, and the graph words `graph_single`, `graph_fan`, and `graph_orch`, with the words in [Names](#names).
  - They are not in `NOUN_KEYS`, so every theme shows the same word.
  - Geek shows it as plain text in the role slot. A bracket there would read as a second state tag.
  - **Icons by kind (D16, todo #152).** `unitIcon(role, duty)` (`gui/icons.ts`) names a unit's icon: its kind's (`#i-<duty>`, one symbol per kind in Standard's sprite, the same game-icons.net source and credit), else its position's. A train keeps the locomotive; the tower and the head keep theirs. `fillPlate(plate, role, mark, docs, duty)` passes the duty at every site that draws a unit's plate: the map's cards and tokens, the drawer's rows, the dossier, an alert's face, and the chat avatar; the ally card's row of a main draws it from the box's `kind`. A launched subagent's kind is `Unit.duty`, read from the agent role its launch script names (`PI_SUBAGENT_AGENT`, through `dutyOfAgent`); a subagent with none, or a role `dutyOfAgent` does not know, keeps the subagent icon. Raven Keep has no twin for the kinds and draws Standard's (`iconRef`'s fallback), as for the train.
  - **Sidebar and dashboard.** `KIND_MARK` (`src/herdr.ts`) gives a kind its Nerd Font glyph (names from Nerd Fonts 3.5.1's glyphnames.json): coordinator md-ship_wheel U+F0833, integrator fa-code_fork U+F126, standing md-lighthouse U+F09FF, train fa-train U+F238, worker md-wrench U+F05B7, scout md-binoculars U+F00A5, planner md-pencil_ruler U+F1353, reviewer md-magnify U+F0349, watchdog md-dog U+F0A43. A main's `sb_mark` is its kind's glyph (the star when the kind is unknown) and a launched subagent's its kind's glyph alone (`[sub] <launcher>` when it has none); `[ally]` and a member's person stay. The dashboard draws the same glyph before a row's name, with the role word in the kind column as before.
- **Helper.** `roleWord(role, duty?, graph?)` returns the kind word if there is a duty, else `roleName(role)`. For a main with a graph it appends ` · <graph word>`, as `協調者 · 分支匯流`. The card and the dossier pass `u.todo?.graph`; other sites pass none.
  - **Sites that hold a `Unit` pass `u.duty`:** the card (`gui/render.ts:158`), tokens, Zen's meta, and the dossier.
  - **Sites that hold a key look up `locate(scene.net, key)?.u.duty`:** layer alerts and drawer rows.
  - **Sites that stay on the role:** the chat speaker, wait titles (whose role is stored at write time), box runs, trust asks, and Raven's `data-role` rooms.
  - **The comms header** (`gui/session.ts:134`) adds the kind word as one more part.
- **A switch shows in three places.**
  1. A `NetEvent` `kind: "duty"` with `from` and `to` reaches the timeline, as `<name>：協調者 → 值守`. A graph change is no event: the card follows the plan.
  2. `items.ts` gets `case "boss_duty": [a.duty, first(a.reason, 120)].join(" · ")`.
  3. The yard card of a switched-away integrator says it changed kind (§2).
- **Byte caps** (`tests/imports.test.ts`) are measured again and updated.

### 12. Link and remote devices

- **Paired devices** see everything, as today.
- **The work board** (the `board` kind that towers read with `board_read`) carries no role and no kind.
- **The ally card carries the kind (boss decision 11/10, todo #150).** The first version left the kind off everything an ally sees, so a box's mains read as plain mains next to a card that said nothing of the trains and the integrator it runs. A box's `unit-status` now names each main's kind:
  - **Wire.** An entry of `mains` gains an optional seventh field, `kind`: `coordinator`, `integrator`, or `standing` (the duty the main published as `sb_duty`, as the net's `Unit.duty` reads it), or `train` (a pane whose `sb_role` is `train`). It is at most `LIMITS.mainKind` = 16 bytes (the longest word is 11), cut when it is written and again when it is read. It is left out when the box knows no kind, so an entry with none is the six fields of before. The decoder takes six or seven fields and refuses any other count.
  - **Caps.** `unit-status.kind` is in `CAPS_FEATURES`. The box writes the field only to a controller whose fresh `caps` list `unit-status.mains` and `unit-status.kind`; to every other it strips `kind` from each entry, since a decoder of before takes exactly six fields and would drop the whole status. An older device therefore reads what it read before.
  - **Who sees which main does not change.** `mains` is still the mains the controller may stop: its own, or the team's for an admin (the [remote stop spec](2026-11-07-link-remote-stop.md) §3.2). The kind is a word on those rows, not a wider list.
  - **The page.** `MainCard.kind` keeps the four words and drops any other. The row of the Mains fold draws the word between the name and the state with `roleWord`, as the local page does: the same word in every theme (§11), and `train` through the role noun; a main with no kind draws no word. The row also draws the kind's icon (D16, §11): a train's locomotive, the main's own icon for a main with none or one the page does not draw.
  - **A tower's runs are not units.** A box tower wakes a short run for each message (an ally run, an event run). The ally card says a tower unit in the service's `running` or `waking` state is a *run in progress* and, in the tooltip of the state word, that the tower stands by between runs; it does not say *running*, which a plain unit's `working` keeps. On the operate base of the same box the finished runs (the ledger's `ally`, `run`, and `tower` roles) are their own closed fold, *Tower runs*, beside the agents' *Earlier runs*, and never rows among the agents.
- **Operate controllers.**
  - The kind word and the graph cross in the snapshot (D13, Q2 「可以」): the sanitizer keeps `duty`, event `kind: "duty"`, and `todo.graph` (`src/server/operatesanitize.ts:77`).
  - The reason is not redacted (decision of the sb main owner, AK2-F005). A controller already sees it: it mirrors the main's pane, where pi prints the call's arguments; it reads the history; and, with box scope, it reads the tower runs whose brief carries the digest line.
- **The header** gains `kind=watch_report` (phase 3). There is no `duty=`.

### 13. Audit (D2: 「留紀錄」)

| Record | Holds | Lives | Reader |
|---|---|---|---|
| Session entry `{ duty, dutyFrom, dutyWhy, dutyAt }` | Every switch and migration, with its reason | The session file | Restore; the comms |
| Tower digest line | The switch, cut to 80 characters | Workspace tokens until read | The tower |
| Server log `duty {key, name, from, to}` | Each change the net observes | The server log | The boss |
| Timeline event `duty` | from → to | 30 minutes | The page |

## Shared contracts (independent review)

1. **Net snapshot.** `Unit.duty`, `TodoSum.graph`, `NetEvent.kind: "duty"`, and `ProjectYard.integrator.switched`. The page, paired devices, Zen, and operate controllers read them.
2. **Link operate.** The sanitizer's new fields (`duty`, `todo.graph`, the `duty` event).
2a. **Link wire (todo #150).** The optional seventh field `kind` of a `unit-status` main, `LIMITS.mainKind`, and the `unit-status.kind` feature of `caps` that gates it (§12).
3. **The bridge's dialogs message.** `TodoSum.graph` from each session's bridge, checked by `todoOk` and copied by the hub's rebuild (`src/dialogs.ts:145`).
4. **Dispatch.** A coordinator main whose todos name no graph, in its state or in earlier `todo` calls of the same message, is refused a `worker`, an unknown role, or a bare or handoff spawn (§2a). Scouts, planners, and reviewers pass, and in phase 3 the watchdog. Integrators and standing mains always carry `dispatch.md` and are never gated.
5. **Pane tokens.** `sb_duty`: mains publish it, every other role publishes `null`, and it is cleared at shutdown. The net reads it, and so does `order.ts` for members' sort, which reverses TT-F002 for display. Phase 2 adds `sb_open_duty`.
6. **Session entries.** The `duty*` fields and the migration entry. Phase 2: a child's `{ agent }` entry and `RoleRecord.duty`.
7. **Train guard.**
   - It gates `train` todos on the integrator duty.
   - Only the integrator duty writes the yard.
   - The migration runs only while `s.duty` is unset and integration is on: by name at start and on `session_info_changed`, by train todos at start and before each run. It writes at most one entry per session.
   - `integrator` counts only while both the guard and the prompts have integration on.
8. **Phase 2.**
   - `board_read` rows, if they show the duty.
   - The role pack: sb registers on pi-herdr-agents' discovery protocol. Its role names would collide with pi-herdr-roles', so commit A removes pi-herdr-roles while the global layer still holds every role.
9. **Phase 3.**
   - The routes `watch-read` (45 s hold, no cap, 55 s client timeout, `deadline`, `now`) and `watch-report` (linked by session file; a session file that does not exist yet is accepted when its watchdog script names it).
   - The header `Kind`.
   - Child-side registration, the `tool_call` block, and the refusal to start.
   - Upstream asks (todo #49).
10. **Outside this repo (phase 2).** weihung-basic-agent's commits A and B.

## Phases

**Phase 1 (todo #137).** Steps 2, 3, 3a, 4, 5, and 9 ship together.

1. `src/duty.ts`.
2. `State.duty`, `Saved.duty`, the migration (guarded on `s.duty`; the name at start and on `session_info_changed`; train todos at start and at `before_agent_start`), `boss_rename`'s migration line, `dutyNow()`, `boss_duty`, and the digest note.
3. The briefing: `promptOf(role, dutyNow(), planGraph(...))`, the kind and dispatch addenda in `PROMPTS`, `{{duty}}`, and the rebrief on a duty or graph change, including after a `todo` tool result (§2a).
3a. The dispatch refusal in `src/session.ts`'s `tool_call` handler (§2a).
4. The train guard: `env.duty()`, the gate, the yard writer, and the switch-away check.
5. Presence: `sb_duty` and its clear, `whoAmI`, `whoMember`/`integratorTab`, and the three TT-F002 texts.
6. The net: `Unit.duty`, `graphOf`, `planGraph`, `Todo.graph` and `TodoSum.graph` with `todoOk` and the hub's rebuild (`src/dialogs.ts:145`), `YardJoin.integrators`, the switched yard card, and `duty` events and log. Delete `integrators()`, `isIntegrator`, and `tests/train-tokens.test.ts:9-53`.
7. The page: the `kind_*` and `graph_*` messages, `yard_integrator_switched`, the yard messages taking `{kind}`, `yard_notice_escalated` as 送車者 (base and Raven), the live card for a writer with no `sb_duty`, `roleWord`, the comms header and tool line, and the timeline.
8. Operate: the sanitizer keeps `duty`, `todo.graph`, and the `duty` event.
9. Prompts: `main.md`, `planning.md`, `dispatch.md`, the two `graph-*.md`, `duty-standing.md`, `integrator.md` (`{{dir}}`, "the slip's sender"), `train.md:17`, and `tower-run.md`.
10. Docs.
    - how-it-works: the roles table, Tools, "What it writes", and the fact that each `/reload`, `/new`, `/resume`, and `/fork` reads the integration switch again.
    - The README's tool list.
    - The release note (§4, and §2a's line on plans before dispatch).

**Phase 2.**

1. Each child's `{ agent }` entry. The net links a resumed child by the script carrying `PI_SUBAGENT_ID`, then its session file, then its pane, which also fixes running resumed children showing as `done`. It reads the role from the session file, falling back to the launch script (§8).
2. `boss_open_main` `duty`, `sb_open_duty`, and `RoleRecord.duty`. The tower opens an integrator with `duty`.
3. `boss_status` and `tower_list` show each main's kind.
4. A standing main's board entry is exempt from `stale`.
5. **The role pack (D11).**
   1. **sb.** `roles/` with the six roles (§9), `src/rolepack.ts` in `pi.extensions`, `roles` in `files`, `NOTICE.md`, `/boss roles-check`, and the D7 role checks. The release note says:
      - sb now ships these roles; uninstall pi-herdr-roles, whose names would collide and be disabled;
      - a global or project role of the same name still wins, so the pack's `tools:` lines take effect only where no such role exists (for this machine, after commit B).
   2. **weihung-basic-agent commit A, with that sb release (AK6-F001):**
      - bumps the `npm:pi-straw-boss` pin (`scripts/pi_root/pins.py:69`) to it;
      - **take pi-herdr-roles out (AK8-F002).** Removing its source alone would not do it: `apply` keeps every settings package it does not own as unmanaged (`scripts/pi_root/packages.py:268-275`), and only `PINNED_GIT` and `RETIRED_SOURCES` count as obsolete (`:58-61`, `pins.py:30-36`). So commit A:
        - adds `"npm:pi-herdr-roles"` to `RETIRED_SOURCES`, with the comment "pi-straw-boss ships the roles", so `apply` drops the settings entry and `remove_retired_installs` (`packages.py:64-76`) uninstalls it;
        - deletes `HERDR_ROLES_SOURCE` and `HERDR_ROLES_PACKAGE` (`pins.py:14-15`) and the `PACKAGES` entry (`:51`);
        - updates `tests/install.sh:74` (the import) and `:100` (the asserted package order);
      - **keeps** `agents/*.md`, and adds `agents/planner.md`, a copy of sb's `roles/planner.md` **without its `tools:` line**, like the other overrides, so the planner keeps every tool until B, as it has today under pi-herdr-roles (AK7-F006);
      - drops pi-herdr-roles from the texts that name it:
        - `MANUAL_PINS` and the re-derive note (`scripts/pi-pins.py:28-30`, `:166-167`);
        - the `PI_HERDR_AGENTS_ROOT` message (`scripts/pi_root/packages.py:153`);
        - `docs/reference.md:48` and `:61`;
        - `AGENTS.md:15-16` (`skills/orchestrate`, and the `agents/` line, which now says the overrides shadow sb's pack until B);
        - `skills/maintaining-pi-setup/SKILL.md:22` (step 4's re-derive note).

      Cited at weihung-basic-agent 029833e. Step 4's check after A shows any leftover as six `duplicate-package-role` diagnostics, before B could make the roles vanish.

      **Why the roles never vanish.** pi-herdr-agents reads the global layer from disk at every listing and launch (`maestro/core/roles/discovery.ts:585`), and `~/.pi/agent/agents` is a symlink to `agents/` (`install.sh:281`). While `agents/` holds all six roles, every session resolves every role from there:
      - an old session that has not reloaded, whose pi-herdr-roles path is gone, gets only a `missing-role-pack-path` diagnostic in listings;
      - a reloaded session has sb's pack under the global roles, and there is no collision, because pi-herdr-roles has left the package layer.
   3. **weihung-basic-agent commit B, once no pi older than commit A's install runs:**
      - delete `agents/*.md`, the install step that links them, and the installed link;
      - update `docs/reference.md:48`.

      **When B may run: after every pi has been restarted (AK7-F005).** Every pi process was started after A's install. Take each pane's PID from `herdr pane process-info --pane <id>` (`pgrep -f` cannot find pi, AGENTS.md "Live checks"), and compare `ps -o lstart= -p <pid>` with the install time. Panes outside Herdr are restarted by hand.
      - A `/reload` would also load the new sb's pack, but nothing outside the process can see that it happened, so the check counts restarts only.
      - B has no deadline. Until B nothing is broken; only the pack's `tools:` lines wait, because the overrides shadow them. They take effect at B.
   4. **Check after each commit.** `subagents_list` shows every role resolving, with no diagnostic beyond the expected `missing-role-pack-path` before reloads. After A, the roles come from the global layer; after B, from `pi-straw-boss`. `/boss roles-check` passes.

**Phase 3.**

1. sb: `watch_read`, `watch_report`, child registration, the block, and the refusal to start (§10). The dispatch gate lets `watchdog` pass without a plan (§2a, AK7-F004).
2. `roles/watchdog.md`, with its checks, and the watchdog line in `duty-standing.md`.
3. The upstream asks (§8).
4. Sidebar marks per kind (`src/order.ts:99-101`).

## Tests (red first)

**Phase 1**

- **`boss_duty`.**
  - A switch writes all four fields, sets the duty, publishes, rebriefs, and notes the digest.
  - Each of these is refused with its own text:
    - the same duty;
    - a member;
    - a train;
    - a remote turn;
    - a hidden `integrator` (the enum lacks it, and a raw call is refused);
    - a switch away with a pending or in-progress train todo.
  - A reason that is empty, over 200 characters, or multi-line (collapsed) is handled. A tower has no tool.
- **Migration.**
  - **Ledger.** A session named `integ FE2`, with todos lacking `metadata.sb`, a ledger file, and no yard: after `session_start` it has the entry `migrated: name`, publishes `integrator`, and its first run's section holds `integrator.md` and the integration line. None of its todos is refused.
  - **Takeover (AK3-F001).**
    - A main that started as `Session 脈絡毀損接手`, with no duty entry, calls `boss_rename integ FE2` mid-run. Expected: the `migrated: name` entry, one rebrief steer carrying `integrator.md`, and `sb_duty=integrator`.
    - The `boss_rename` reply carries `Your kind is now integrator (migrated by name)`.
    - A rename through pi's `/name`, and a mid-run `pi.setSessionName("integ FE2")` from another extension, each migrate at once through `session_info_changed`.
  - **Sign 1's pattern.** `integ v3` and `integ insight` match. `integ tests MP-1`, `integration notes`, and a bare `integ` do not.
  - **A rename away.** Renaming from `integ FE2` to anything else keeps `integrator`.
  - **Restore.** A restore with a new pid, a dead yard writer, and `train` todos gets the entry `migrated: train todos`.
  - **A declared kind wins (AK4-F001).**
    - A main named `integ FE2` declares `coordinator` mid-process. The next `before_agent_start` keeps `coordinator` and appends nothing, and so does a restart.
    - A main with no declared duty that calls `boss_duty coordinator` gets an entry, and a later rename to `integ FE2` does not migrate it.
    - A migrated main that runs 3 times has exactly 1 migration entry.
    - A trainboard integrator whose train todos are all completed switches away and stays switched on its next run.
  - With integration off, no migration entry is written. The next load with integration on migrates.
- **Briefing.** A coordinator's section is `main.md`, declared or not; an integrator's and a standing main's add their addendum; a mid-run switch steers once.
- **Default.** A main with no entry publishes `sb_duty=coordinator`. With integration off, a declared integrator publishes `coordinator` and runs `main.md`.
- **Graph (D10).**
  - Open todos whose highest-id graph-bearing one says `orchestrator-worker`, beside an older open `fan-out/fan-in` plan: the sum's graph is `orchestrator-worker`.
  - Completed todos and train steps are ignored, so a finished plan has no graph.
  - Open todos with only `metadata.anchor` (pi-anchorloop's): no graph. No todos: no graph.
  - **Review 6's live values:** `fan-out` and `fan-out/fan-in` give `fan-out/fan-in`; `single`, `single-loop`, and `single-loop then worker` give `single-loop`; `orchestrator-worker` stays itself. `fanout`, `chain`, and `""` give none, and `todoOk` refuses a non-`GRAPHS` value in a raw message.
  - **Bridge → hub → unit (AK6-F004).** A bridge message with `todo.graph` reaches `u.todo.graph` through `src/dialogs.ts:145`, with no direct injection of `u.todo`.
  - The card shows `協調者 · 分支匯流` for a main, `整合員 · 單一迴圈` for an integrator with a single loop, and no graph for a member.
- **Dispatch rules follow the plan (D14).**
  - With no graph, a coordinator's section has no `## Dispatch` and no `## Graph:` header. With each graph, it has `dispatch.md` and, for two graphs, that graph's addendum.
  - **Integrator and standing (AK8-F001).** Their section always holds `dispatch.md` and never a `## Graph:` header, with or without graph todos. Writing and completing a graph todo sends them no steer, and their card still shows the graph.
  - A `todo` call that adds the first `fan-out/fan-in` todo mid-run steers once with the dispatch addenda. Completing the last graph todo steers once without them. A second `todo` call that changes nothing sends no steer.
  - **The refusal.** A coordinator with no graph calling `subagent` with `worker`, an unknown role, or no `agent` is blocked with the `plan first` text. An integrator and a standing main with no graph dispatch a `worker` with no refusal. `scout`, `planner`, `reviewer`, `visual-tester`, and `adversarial-reviewer` pass. `subagent_resume` passes. A train and a member are never blocked by it. A member promoted by the same call is blocked as the main it now is.
  - A ledger integrator with no graph todo dispatches a `reviewer` with no refusal and no steer (AK7-F001).
  - **The same message (AK7-F002).** One assistant message with `todo create {metadata:{graph:"fan-out"}}` then `subagent {agent:"worker"}` passes. So do `create` with `tasks[0].metadata.graph` and `update` with `metadata.graph`. A `todo` call after the `subagent` call in the message, or one with no known graph, does not count. The test runs against pinned pi with `toolExecution: "parallel"`. A codemode `subagent` call (`parentToolCallId` set) is judged by state alone: after an awaited `todo` with a graph it passes, and run beside it in `Promise.all` it is refused (AK8-F005).
  - **The steers (AK7-F008).** A graph that appears steers `Your plan's graph is now fan-out/fan-in. Add to your instructions:` with `dispatch.md` and the graph addendum, and not the role text. A change to `single-loop` steers `Drop your "## Graph:" section.`. The end of a plan steers the drop line. No steer holds `main.md`.
- **Label = prompt.** For each case of role × duty × switch, the published `sb_duty` equals the chosen addendum. The cases include:
  - integration off;
  - an injected `trainOn=false` with prompts on (AK3-F003);
  - a demoted main, which publishes `null`.
- **Train guard.** A train todo with no integrator duty is refused, and after a switch away a `turn_end` writes no yard.
- **Presence.** A member sorts beside a main whose `sb_duty` is `integrator`, and not beside a former one.
- **Yard card.**
  - A switched-away live writer shows `yard_integrator_switched` and no Yard button.
  - A gone writer shows `yard_integrator_gone`.
  - A live writer with no `sb_duty` token (an older sb) shows the live card.
  - The messages carry the `kind_integrator` word.
- **Restore.** A last entry of `standing` publishes `standing`.
- **Net.**
  - `sb_duty` is read only for mains, and an unknown value is ignored.
  - `duty` events are emitted.
  - `dutyOfAgent("constructor")` is undefined.
- **Operate.** The sanitizer keeps `duty`, `todo.graph`, and the `duty` event, and drops an unknown graph value.
- **D7.** The repeat check over every composed prompt (role × kind × graph), the caps, the `integrator.md` and `dispatch.md` pins, the no-growth sum over `main.md`, `dispatch.md`, and `planning.md`, and `main.md` at 28 lines or fewer. The test fails if the sum is not below 9,676 (9,581 on the drafts).
- **The kind in the prompt.** `{{duty}}` renders `coordinator` for a main with no entry, and `standing` after a switch.
- **The slip's sender.** `yard_notice_escalated` reads 「{ticket} 的送車者聯絡不上」 in the base and Raven messages. The slip's `coordinator` field is unchanged.
- **A rename that does not migrate (AK6-F008).** A main that declared `standing` and renames to `integ FE2` keeps `standing`, and its `boss_rename` reply carries `Your kind stays standing`.

**Phase 2**

- **The role read.**
  - A child with `PI_SUBAGENT_AGENT=scout` writes `{ agent: "scout" }`, and the net labels it `scout`.
  - **Resume (AK3-F002, AK4-F002).** A resume has a new id, a `<name>-resume-<ts>.sh` script with no `PI_SUBAGENT_AGENT`, and the same session file. Expected:
    - the row's `file` is the session file;
    - its pane is found by `agent_session`;
    - its mark is the pane's (not `done`), and its name is the script's name;
    - it keeps the label, including when the resumer is another parent.
  - The first `{ agent }` entry wins over a later one.
  - Before the first `turn_start`, the launch script stands in for the entry.
  - An unknown role name, a handoff, and a bare spawn get no duty.
- **The opener.** `sb_open_duty` is consumed with `sb_open_main`, and a restore before the first message gets the duty from the record.
- **The role pack.**
  - `src/rolepack.ts` registers `roles/` for `apiVersion: 1`, ignores another version, and unsubscribes at `session_shutdown`. It registers in a child too.
  - **Role file shape (AK6-F007).** The test re-implements the three checks pi-herdr-agents' catalog makes (`discovery.ts:495-575`): the name matches the file stem, there is a description, and `tools:` is a comma list of names. sb has no pi-herdr-agents devDependency, and tests/setup.ts's temp HOME keeps the installed host out of reach. Tool existence is `/boss roles-check`'s job, not this test's.
  - The pack's `reviewer` and `adversarial-reviewer` end with the `Blocking: P0=<n> P1=<m>` line, the `worker` keeps its "Stay in the turn" rule, and the `scout` keeps `thinking: low` (each carried from the overrides).
  - The D7 role checks: no repeated sentence within a file, and each file at or under its pinned length.
  - `npm pack --dry-run` lists `roles/`.
  - **Attribution.** `NOTICE.md` holds the HazAT MIT notice verbatim and names the derived role files.
- **Role tools.** `rolesCheck` passes a fixture whose names are all present or child-only. It fails one with a missing name and one that names `boss_status` (parent-only), listing each with its reason. `/boss roles-check` starts no process (it is called with a fake `spawn` that throws), refuses when `process.argv` holds `--tools`, `--exclude-tools`, or `--tools=read`, and with no argument reads its own package's `roles/`. The recorded sb registry without `PI_SUBAGENT_ID`, less the one with it, equals `PARENT_ONLY`. With `PI_SUBAGENT_ID` the watch tools are registered, and without it they are not.

**Phase 3**

- **`watch_read`.**
  - It returns at once on a stamp mismatch.
  - A monitor printing one line a second does not wake it.
  - A status change, a todo completion, and a train step each wake it.
  - `stalled` comes once, and again only after the unit moves and goes quiet again.
  - A 5-minute reading gap restarts the quiet clock and gives no `stalled`.
  - A subagent target's quiet clock moves on its mark and note.
  - A monitor with no load lines never gives `load`, and a crossing gives `load` once.
  - It returns `unchanged` at `waitMs`, after re-polls inside the 45 s hold, each with an `onUpdate`.
  - A message arriving during the call returns it early. A follow-up already pending at the start does not make two quick returns in a row.
  - It returns `expired` at the `deadline`, and every reply carries `now`.
  - A server restart mid-hold is retried. A server still down at `waitMs` gives `unchanged` with `server: "unreachable"`.
  - A `waitMs` of 3,000,001 is refused, and a 5-minute wait survives the 60 s socket idle close.
  - 20 polls are held at once.
  - It returns `gone` with the successor.
  - An unknown key is an error, an abort ends it, and it carries no transcript or path.
- **`watch_report`.**
  - It delivers under `kind=watch_report`, `role=session`.
  - A resumed watchdog (new id, `-resume-` script, the entry in its session) is accepted.
  - These are refused:
    - a path outside the sessions folder;
    - no script tying the id to the session;
    - a child that is done;
    - a session that is not a watchdog's.
  - A first launch whose session file does not exist yet is accepted when its watchdog launch script names it.
  - It is rate-limited and has no target parameter.
- **Holding D3.**
  - A first launch with a widened list blocks `bash` and `intercom`.
  - A late `registerTool` after the narrowing re-widens the view, and the block still holds.
  - A resume with no `PI_SUBAGENT_AGENT` is known by its entry.
  - A first-launch watchdog whose `tools` override lacks the watch tools: the dispatcher receives `cannot start`, the child ends, and no provider request is made (or at most one short turn whose tools are all blocked).
  - A scout spawned with `watch_read` in its `tools` is not treated as a watchdog.
  - The tools are inactive in a worker, scout, or reviewer child.
- **The gate.** A standing main with no graph dispatches a `watchdog` with no refusal and no steer (AK7-F004).

## Names

D9 and D13: one word per kind, the same in every theme. English words are lowercase, like the role words.

| Kind | zh-TW | en |
|---|---|---|
| coordinator | 協調者 | coordinator |
| integrator | 整合員 | integrator |
| standing | 值守 | on watch |
| worker | 工作者 | worker |
| scout | 偵察 | scout |
| planner | 規劃 | planner |
| reviewer | 審查 | reviewer |
| watchdog | 監控者 | watchdog |
| train | 火車 (the role word today) | train (the role word today) |

Graph words (D10, D15), shown after a main's kind word:

| Graph (planning.md) | zh-TW | en |
|---|---|---|
| single-loop | 單一迴圈 | single loop |
| fan-out/fan-in | 分支匯流 | fan-out |
| orchestrator-worker | 多工編排 | orchestrated |

A relay such as spec-chain, the boss's 鏈主, has dependency edges, so planning.md makes it `orchestrator-worker`, shown as 多工編排 (AK6-F010).

## Open questions

None. Q1 to Q9 are decided (D10 to D15).

## Review history

Each finding of rounds 1 to 7 is listed with the section that now holds its resolution. The sections, not this table, give the current numbers.

| Findings | Resolved in |
|---|---|
| AK-F001, AK2-F002, AK2-F003, AK3-F004, AK3-F005, AK4-F005 | §10 `watch_read`: a long-poll that wakes on state only; the server judges stall and load; 45 s holds with re-polls inside one call; `onUpdate`; the `waitMs` cap; `deadline` and `now`; a failed hold is retried. |
| AK-F002, AK2-F001, AK3-F001, AK4-F001, AK4-F004 | §2 migration: by name (`^integ \S+$`, on `session_info_changed`) and by train todos, never by the yard pid; guarded on the live `s.duty`, one entry per session. |
| AK-F003, AK2-F009.1, AK3-F003 | §2 `dutyNow` (both reads must have integration on); every session replacement re-reads the switch. |
| AK-F004, AK2-F007, AK3-F008.5 | §2: only the integrator duty writes the yard, and the yard card follows `Unit.duty`; `integrators()` is deleted. |
| AK-F005, AK2-F006, AK4-F003 | §10 `watch_report`: no target parameter; the server's checks, a not-yet-written session file included; `role=session`; the refusal at the first `before_agent_start`. |
| AK-F006, AK2-F005 | §12: the reason is not redacted (decision of the sb main owner). |
| AK-F007, AK-F009, AK2-F009.4 | §9 drafts and the D7 acceptance. |
| AK-F008, AK-F010, AK-F011 | §9: the watchdog mention is in phase 3; the code reviewer gets `write`. Round 6 dropped the chain and fanout addenda (D10). |
| AK-F012, AK2-F009.2, AK3-F008.4, AK6-F002, AK6-F003 | §9 tool-set acceptance: `/boss roles-check` in a live session against `pi.getAllTools()`, with no probe process. |
| AK-F013 | §6 `RoleRecord.duty`. |
| AK-F014, AK2-F004, AK3-F006, AK4-F006.k | §2 (`sb_duty: null`, the sort), §1 (`Object.hasOwn`), §9 (the planner, now in sb's pack), §10 (Holding D3; the tool list is no sign). |
| AK-F015, AK-F016, AK3-F008.1–3, AK4-F006 | Citations, sites, tests, the header, the deleted test, the switch cost, and review 4's consistency items. |
| AK2-F008 | §2: the TT-F002 reversal and its three texts. |
| AK2-F009.3, AK3-F002, AK4-F002 | §8 and §10: a child is linked by its session file; a resumed child by the script carrying its id. |
| AK3-F007 | §10 and Q7: what load and stall can see. |
| AK6-F001 | Phase 2 step 5: commits A and B, with the global layer as the bridge. |
| AK6-F004, AK6-F005 | §2: `graphOf` aliases, no anchor fallback, `planGraph`, and the hub's rebuild. |
| AK6-F006 | §9 Attribution: the HazAT notice. |
| AK6-F007 | Tests, phase 2: the role file shape re-implemented. |
| AK6-F008 | §2 `boss_rename`'s "stays" line; §9 `{{duty}}` in `main.md`. |
| AK6-F009 | §1 the slip's sender; §2 the graph shown for every main. |
| AK6-F010 | Names: the chain line. |
| AK6-F011 | §9: `adversarial-reviewer` keeps every tool; the planner gets `edit`. |
| AK6-F012 | §9: the standing row, the tower's wait card. |
| AK7-F001, AK7-F004, AK7-F007 | §2a: the gate refuses only `worker`, unknown roles, and bare or handoff spawns; reviewers and the watchdog pass; `main.md:6` and `:7` stay; the rationale; the note on the global AGENTS.md. |
| AK7-F002 | §2a: the gate reads earlier `todo` calls of the same message. |
| AK7-F003 | §9: the measured drafts and the numbers. |
| AK7-F005, AK7-F006 | Phase 2 step 5: B counts restarts only; A's planner copy has no `tools:` line. |
| AK7-F008 | §2a: no `graph-single-loop.md`; the steers name the plan change and carry only the change. |
| AK7-F009 | §9: the default folder, the parent-only list, the refusal in a child. |

Not taken as proposed:

- **AK-F009:** no inline marker.
- **AK2-F003 and AK3-F005:** the short hold rather than a `socket.ts` change.
- **AK2-F008:** the TT-F002 reversal is kept.
- **AK3-F006:** the refusal goes through `watch-report` and `ctx.shutdown()`, not `caller_ping`.

## Round 6: the boss's answers

| Decision | What changed |
|---|---|
| D10 | §1: `COORDINATOR_DUTIES` is `coordinator`, `integrator`, `standing`, and `GRAPHS` is added. §2: `dutyNow()` defaults to `coordinator`; the graph rule. §3: the enum and description; declaring `coordinator` while undeclared writes an entry. §5: the default is a coordinator. §9: no chain or fanout addendum, and `main.md`'s second line becomes "and `boss_duty` when its kind changes". §11: the graph after the kind word. Tests for the graph and the default. |
| D11 | "What sb has today": where roles come from, and what each override carries. §9: sb's `roles/` and `src/rolepack.ts`; the tool check moves to sb. Phase 2 step 5: the pack and the order of the weihung-basic-agent change. Q9 for `/plan`. |
| D12 | §9: a standing main asks only through the wait card, and under auto mode (todo #140) never waits. |
| D13 | §12: the kind word and the graph cross to operate controllers. §4: the gate stands. §9 and §10 stand. Names: one word each. |

## Round 7

Review 6: `review6.md`, with P1=2, P2=5, P3=5. Every finding is taken, and each row of the Review history names where it went.

| Item | What changed |
|---|---|
| D14 (round 7; the gate and line counts revised in round 8) | New §2a: the plan counts once its todos name a graph; the dispatch addenda; the line inventory from `main.md` and planning.md §5; the refusal for a main with no plan (only `scout` and `planner` may run); the rebrief and its cost. §9: the drafts for `main.md` (29 to 27 lines), `dispatch.md`, the `graph-*.md` addenda (two since AK7-F008), and planning.md, plus the D7 checks per composed prompt and the no-growth sum. Phase 1 steps 3, 3a, and 9. Shared contract 4. |
| D15 | Names: the graph words are final. §9: `/plan` and the `plan` skill go. No open questions remain. |

Not taken as proposed:

- **AK6-F002 and AK6-F003.** The review fixed the probe: `env -i`, linked packages, the checkout's sb, the host's child extension. I removed the probe instead. `/boss roles-check` compares names in a session that already runs, so nothing new starts and nothing needs isolating. The cost is one blind spot, a tool registered only outside children, which §9 names.
- **AK6-F005.** The review offered keeping the anchor fallback for exactly one open todo. D14 needs a stated graph before any dispatch, so planning.md now asks a single loop to name its graph when a subagent carries it, and the fallback is dropped.

## Round 8

Review 7: `review7.md`, with P1=1, P2=3, P3=5. Every finding is taken, and the Review history names where each went.

- **The gate (AK7-F001), a decision of the sb main owner.** D14 settles the prompts only. Gating reviewers was the spec's own addition, so it is withdrawn: without a plan sb refuses only `worker`, unknown roles, and bare or handoff spawns. `main.md:6`, the brief, stays in `main.md`, because scouts, planners, and reviewers get briefs too. Integrators and standing mains were said here not to be slowed; that held for reviewers only, and round 9 corrects it (AK8-F001).
- **The measurement (AK7-F003).** On the exact drafts in §9: 9,676 characters before, 9,579 after (−97). A main's own prompt: 4,918 with no plan (−379 against today's 5,297), 5,419 with a single loop, 5,573 with a fan-out graph (round 9: 5,578 for orchestrator-worker, and the sum is 9,581 after `planning.md:3`'s new wording).
- **`main.md`** now goes from 29 lines to 28, not 27, because `:6` stays.

## Round 9

Review 8: `review8.md`, with P0=0, P1=0, P2=2, P3=5. This is the last spec round. Every finding is taken.

| Finding | What changed |
|---|---|
| AK8-F001 (P2), a decision of the sb main owner | §2a: an integrator and a standing main always carry `dispatch.md` as part of their kind's prompt, and are never gated. The plan gate and the graph addenda apply to coordinators only. Their card still shows the graph when they have a plan, and a one-off worker switches no prompt. The cost, the release note, the tests, and decide.md are corrected. The Round 8 sentence is marked as corrected. |
| AK8-F002 (P2) | Phase 2 step 5.2: commit A puts `npm:pi-herdr-roles` in `RETIRED_SOURCES`; deletes `pins.py:14-15` and `:51`; updates `tests/install.sh:74` and `:100`, `AGENTS.md:15-16`, `skills/maintaining-pi-setup/SKILL.md:22`, and the texts listed before. |
| AK8-F003 | §9: orchestrator-worker is 5,578. A per-kind table adds the integrator (8,694) and the standing main (5,824). |
| AK8-F004 | §2: "a worker". §9: the `planning.md:3` draft. The sum is now 9,581 (−95). |
| AK8-F005 | §2a: the pi citations for the same-message read; codemode calls and failed `todo` calls. A codemode test is added. |
| AK8-F006 | §9: `roles-check` runs in a Herdr pane; the dead child refusal is gone; a session started with `--tools` or `--exclude-tools` refuses; `PARENT_ONLY` is an exported list, pinned by a test against sb's recorded registry. §10: the watch tools are registered under `if (env.PI_SUBAGENT_ID)`. |
| AK8-F007 | The title, `review7.md` and `review8.md` in the list, the graph-addenda count in the Round 7 row, and §1's slip-sender lines (`integrator.md:8`, `:12`, `train.md:13`), with the §9 wording for each. |

Figures on the round 9 drafts, in characters:

| What | Characters |
|---|---|
| `main.md` + `dispatch.md` + `planning.md` | 9,581, against 9,676 today (−95) |
| coordinator, no plan | 4,918 |
| coordinator, `single-loop` | 5,419 |
| coordinator, `fan-out/fan-in` | 5,573 |
| coordinator, `orchestrator-worker` | 5,578 |
| integrator | 8,694 |
| standing main | 5,824 |

Today every main runs 5,297, and an integrator also reads `integrator.md` (3,280) once.

## Auto mode note (§9, 2026-11-09)

`prompts/duty-standing.md` sends a standing main's questions to `call_tower` `why: blocked`. No kind prompt grows for auto mode (D7): while auto mode is on, the tower parks such a wait (a card marked `parked`, its raiser told once under `wait_parked`) and the main goes on with work that does not need it. See `2026-11-09-auto-mode.md` §4 and §6.
