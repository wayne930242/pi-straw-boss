# Merge train: one integrator per project (phase 1)

Status: phase 1 implemented as prompts only, on `fix/board-stale` (a489fd5) plus this branch. Source: the design draft `sb-integrator-design.md` (2026-10-30), sections 1 to 9. Section 10 (code) is not built.

## Decisions

The boss accepted Q1 to Q7 as recommended and asked for phase 1 now (Q8):

- One integrator per project, not per app (Q1). It counts toward the tower's two opened mains in phase 1 (Q2).
- Departure defaults `maxCars` 4 and `maxWaitMin` 60; the skill may override them (Q3).
- The coordinator closes tickets; the integrator only when that session is gone (Q4).
- Each car keeps its own review; the integrator adds one review of the merged result (Q5).
- The car slip travels as `call_tower` `why=shared`; no new `why` (Q6).
- An urgent car does not interrupt a running gate unless the skill says so (Q7).

Boss note: Straw Boss is a system that comes with skills. It does not decide how a project handles its checks; it states principles and a contract.

## Principle

A coordinator's anchor before handoff is its review (P0 and P1 clear) plus behaviour tests aimed at its own change. Format, lint, build, full type-check, full suites, publish, and similar quality gates run once, by the integrator, on the integrated pre-dev head. A project skill may name exceptions.

## Contract

- `apps.json`: top level `"integration": {"skill", "maxCars", "maxWaitMin"}`; per app `"integration": {"base", "skill"?}`. An app without it keeps today's flow.
- Skill headings, exactly: `## Light checks`, `## Train assembly`, `## Full gates`, `## Merge`, `## Post-merge`, optional `## Urgent lane`, `## Load`. Missing `Light checks`, `Full gates`, or `Merge`: the integrator does not depart and calls the tower with `why=blocked`.
- Car slip: car, tickets, branch, head SHA, tested-on base SHA; review with P0=0 P1=0 and a report path; light result; migrations; lane; the boss's authorization quoted; the coordinator. A missing field returns the slip.

## Prompt changes

| File | Change |
|---|---|
| `prompts/apps-config.md` | The two `integration` fields and the heading contract. |
| `prompts/integrator.md` (new) | The integrator's role, car intake, departure, assembly, red handling, urgent lane, post-merge. Read before the first departure; not in the system prompt. |
| `prompts/main.md` | An integration app: no own merge or pre-dev claim; send the car slip with `why: shared`; Done when counts the integrator's report. |
| `prompts/planning.md` | The coordinator's anchor and where the other gates run. |
| `prompts/tower-run.md`, `prompts/tower.md` | A `shared` merge request from an integration app goes to the project's one integrator, opened when absent, closed when idle. |

Word budgets (tests/prompts.test.ts) stay unchanged: main.md 484, tower.md 380, planning.md 650. The new text was fitted by trimming other words in the same prompts.

## Not built (phase 2)

`boss_open_main` with an integrator role and a pane token, a separate quota, `{{dir}}` in the tower prompts, an `integrator:` field in `board_read`, and a machine-wide heavy-gate semaphore. Until then single-integrator rests on the tower's prompt and the integrator's name.
