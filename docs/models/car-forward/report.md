# The car model: from a coordinator's slip to what the coordinator learns

A TLA+ model of one car (one head) on its way from its coordinator's slip, through the tower's forward and the integrator's `train_car`, to the notices the sb server sends back. TLC checks three rules on every path the model allows, including a server restart, a day passing, a forward pushed out, a second slip of the same head, a notice that is not delivered, and a coordinator whose session is gone.

The boss, who runs coordinators and trains, confirmed the rules on 2026-11-12. On `191ccfa1` (0.76.0) rules 1 and 2 broke on three paths, filed as issues #13, #14 and #15. The model now describes the code with the three fixes, and every rule holds. Each of the three paths has a replay test in `tests/model-car-forward.test.ts`, red on 0.76.0 and green with the fixes.

## Result

| Rule | In the model | On 0.76.0 | With the fixes |
| --- | --- | --- | --- |
| 1. Every slip the tower forwarded ends with its coordinator knowing the car's outcome or knowing it must send the slip again; when the coordinator could not be told, the tower was told instead. | `NoCarLeftInTheDark` | Broke, two causes (A, B) | Holds |
| 2. A car is never landed twice: its coordinator is told `landed` at most once. | `LandedToldOnce` | Broke, one cause (C) | Holds |
| 3. A notice never names a car its coordinator did not send: it goes to the session that sent the slip, whoever the slip names. | `NoticeToSender` | Held | Holds |

## The files

| File | What it is |
| --- | --- |
| `CarForward.tla` | The model: the steps of each actor and the three rules. |
| `CarForward.cfg` | The full check: 2 slips, 1 restart, 1 day, 2 trains. 9,364 states. |
| `NoRestart.cfg` | The same with no restart. 2,512 states. |
| `Lifecycle.cfg` | The chart the reader confirms: 2 slips, no restart, no day, and nothing going wrong on the way (`Calm` in the model says what that leaves out). 67 states. |
| `view.mjs`, `view-lifecycle.mjs` | The reader's words for each state and step. |
| `check/full`, `check/no-restart`, `check/lifecycle` | What the command wrote: `report.md` of each check, and `chart.mmd` of the lifecycle. The first two draw no chart: they are over the chart's 500 states and no rule breaks, so there is no bug path to draw. |

Run a check again (each takes 3 to 6 seconds; `--out` takes a new or empty folder, so remove the old one first):

```sh
cd docs/models/car-forward && rm -r check/full
<statechart skill>/scripts/statechart CarForward.tla --view view.mjs --out check/full
<statechart skill>/scripts/statechart CarForward.tla --config NoRestart.cfg --view view.mjs --out check/no-restart
<statechart skill>/scripts/statechart CarForward.tla --config Lifecycle.cfg --view view-lifecycle.mjs --out check/lifecycle
```

The command also writes `tlc.out` (TLC's own output, with times and paths of the computer it ran on); it is not kept here.

A larger run, 3 slips and 2 restarts, also holds every rule (77,184 states).

## The three paths of 0.76.0, and what closed each

Each path is the shortest one TLC found on the model of 0.76.0, in the words of that model's `view.mjs`.

### A. Rule 1: a restart lost the notice of a car the integrator returned (issue #13)

```
## NoCarLeftInTheDark breaks
The shortest path has 5 steps:
0. No slip yet
1. the coordinator sends the car's slip to the tower: Slip waits at the tower; coordinator waits for an answer
2. the tower forwards the slip to the integrator: Slip with the integrator; coordinator waits for an answer
3. the integrator returns the car: Returned by the integrator, notice going out; coordinator waits for an answer
4. the notice is not delivered at the first send: Returned by the integrator, notice not delivered yet; coordinator waits for an answer
5. the sb server restarts: The server holds nothing of the car; the integrator is done with it; coordinator waits for an answer
```

The integrator's `returned` at receipt was the one state nobody waited for. A `received` notice holds the integrator's `train` todo, and a `dropped` or `landed` notice holds the train's step, so after a restart the integrator or the train finds the empty book and calls for help. Nothing depended on a `returned` at receipt: the retry at 30 s was in the memory the restart wiped, and the journal on disk is not read back (CR-F003).

**The fix (the boss: the integrator's side waits until the returned notice is confirmed delivered).** The session that returned the car waits for the notice itself (`src/carwait.ts`). It asks the server's book every 15 s. A notice delivered, or told to the tower by the server, ends the wait. When the server no longer holds the car, the session calls the tower `blocked` with the notice text. Nothing is read from disk. In the model: `intWaits`, set by `IntegReturns` and ended by `IntegSeesTold`, `IntegSeesAnswered`, `IntegFindsNothing` (the call) and `IntegEndsWaiting` (the session ends while it waits, and hands the notice to the tower first). A restart leaves `intWaits` alone, so a restart while the session waits ends with the tower told.

Replay: `car model, NoCarLeftInTheDark: a car the integrator returned still ends with its coordinator or the tower told, when the sb server restarts before the notice was delivered`.

### B. Rule 1: the same head sent again after it came back got no answer (issue #14)

```
## NoCarLeftInTheDark breaks
The shortest path has 7 steps:
0. No slip yet
1. the coordinator sends the car's slip to the tower: Slip waits at the tower; coordinator waits for an answer
2. the tower forwards the slip to the integrator: Slip with the integrator; coordinator waits for an answer
3. the integrator returns the car: Returned by the integrator, notice going out; coordinator waits for an answer
4. the coordinator gets the notice: Returned by the integrator; coordinator was told returned
5. the coordinator sends the same head again: Returned by the integrator; another slip waits at the tower; coordinator waits for an answer
6. the tower forwards the slip to the integrator: Returned by the integrator; the integrator holds a new slip of it; coordinator waits for an answer
7. sb refuses the integrator: the car already ended; nothing is set, nobody is told: Returned by the integrator; coordinator waits for an answer
```

A car file is named after the app and the head and took one terminal state, and the book never dropped a car while the server ran. A car returned for its slip, not its code, comes back with the same head, and sb refused both `received` and `returned` for it. No state could be set, so no notice was sent.

**The fix (the boss: a forward newer than the terminal state starts the car's new round).** A forward of the head that the tower made after the car was returned or dropped starts a new life of the car: the integrator's `received` or `returned` is taken, and the notices go out as for a new car. The forward the car ended on still gets no second answer. In the model: `fwdNew` (the forward is newer than the car's newest state) and `Fresh`; the step `IntegAlready` of the 0.76.0 model is gone, because no state reaches it.

Replay: `car model, NoCarLeftInTheDark: a slip sent again for a car that was returned gets an answer from sb, to its coordinator or to the tower`.

### C. Rule 2: after a restart a landed car could be received, ridden and landed again (issue #15)

```
## LandedToldOnce breaks
The shortest path has 16 steps:
0. No slip yet
1. the coordinator sends the car's slip to the tower: Slip waits at the tower; coordinator waits for an answer
2. the tower forwards the slip to the integrator: Slip with the integrator; coordinator waits for an answer
3. the coordinator sends the same head again: Slip with the integrator; another slip waits at the tower; coordinator waits for an answer
4. the integrator sets the car received: Received, notice going out; another slip waits at the tower; coordinator waits for an answer
5. the coordinator gets the notice: Received; another slip waits at the tower; coordinator was told received
6. the tower opens a train with the car: On a train; another slip waits at the tower; coordinator was told received
7. the train merges the car to the base: On a train, merged to the base; another slip waits at the tower; coordinator was told received
8. the train sets the car landed: Landed, notice going out; another slip waits at the tower; coordinator was told received
9. the coordinator gets the notice: Landed; another slip waits at the tower; coordinator was told landed
10. the sb server restarts: The server holds nothing of the car; its train still runs; another slip waits at the tower; coordinator was told landed
11. the tower forwards the slip to the integrator: Slip with the integrator; coordinator was told landed
12. the integrator sets the car received: Received, notice going out; coordinator was told landed
13. the coordinator gets the notice: Received; coordinator was told received
14. the tower opens a train with the car: On a train, merged to the base; coordinator was told received
15. the train sets the car landed: Landed, notice going out; coordinator was told received
16. the coordinator gets the notice: Landed; coordinator was told landed twice
```

What stopped a second receipt was the car file in the server's memory. After a restart the book is empty, so a forward of the same head was received as a new car, and a second train landed it: the `landed` check only asks whether the commit is on the base's remote branch, which it already was.

**The fix (the boss: the rule wins over the spec's "a state set again is told again").** `received` is refused for a head that git, run by the server, finds on the base's branch of the project's remote already. The check asks nothing the book remembers, so it holds after a restart. The refusal is the word the integrator returns the car with, so the coordinator of a head sent again is told where its car is. In the model: `~merged` in `IntegReceives`, and `IntegReturns` for a car the book holds as landed or whose head is on the base. A new life after `landed` (issue #14's rule stretched to it) meets the same refusal: a scratch copy that lets a landed car start a new life keeps rule 2 as long as the check is there, and breaks it in 15 steps, with no restart, once the check is gone.

Replay: `car model, LandedToldOnce: the coordinator of a car is told landed once, when its slip is forwarded again after the sb server restarted`.

## Each rule was shown able to break

A rule that no change breaks was not checked. Each row is a scratch copy of the model with one change, the way wrong code would behave:

| The change | Config | Result |
| --- | --- | --- |
| The integrator's session does not wait for the notice of a car it returned (#13 off) | `CarForward.cfg` | Rule 1 breaks in 5 steps (path A) |
| The waiting session never finds the empty book | `CarForward.cfg` | Rule 1 breaks in 5 steps |
| No new life: a slip sent again for an ended car is refused and the integrator goes on (#14 off) | `NoRestart.cfg` | Rule 1 breaks in 8 steps (path B, after the session's wait ended) |
| `received` is not refused for a head on the base (#15 off) | `CarForward.cfg` | Rule 2 breaks in 16 steps (path C) |
| A landed car may start a new life, the check at `received` kept | `CarForward.cfg` | Every rule holds (9,364 states) |
| A landed car may start a new life, the check at `received` gone | `NoRestart.cfg` | Rule 2 breaks in 15 steps |
| The notice of a returned car goes to the session the slip names | `CarForward.cfg` | Rule 3 breaks in 3 steps |

## The replay tests

`npm run test:one -- tests/model-car-forward.test.ts` was red on `191ccfa1` with these three messages:

```
the coordinator sess-coord-1 was never told its car T-15 is returned, and the tower was never told that it could not be: after the restart sb sent 0 message(s), and its book holds 0 car(s) and 0 pending notice(s)

the coordinator sess-coord-1 was told landed 2 times for one car (landed in 1.2.0, your commit is … / landed in 1.3.0, your commit is …); after the restart, received was: Car T-15 is received; landed was: Car T-15 is landed

the coordinator sess-coord-1 sent head aaaaaaaaaaaa again and sb told nobody anything of it: received was refused (sb: car T-15 is already returned); returned was refused (sb: car T-15 is already returned); sb sent 0 message(s) after the second forward
```

With the fixes all three pass. Two of them were made true to the fixed flow, and each was run red again with its fix taken out:

- Path A drives the step the fix added: the integrator's session waits (`createReturnWatch`), and its looks after the restart are part of the path. Without the wait the test fails with the first message above.
- Path C gives the car a real head that the train pushes to the base at step 7. The first version used a made-up head and landed a commit that was on the base before the car was received; the check of #15 reads the car's head, which that version never put on the base. Without the check the test fails with the second message above.

Each test asserts the rule at the end of its path and treats a step that a fix may refuse as an attempt.

## Where each actor's steps come from

- **The sb server** (book, sender, restart): the code, `src/server/carbook.ts` and `src/server/carnotices.ts`.
- **The integrator and the train**: what `train_car` lets through (`src/traincar.ts`, `carbook.ts`), and for what they do after a refusal, their prompts and the refusal's own words. Asking the coordinator to send again is the #154 refusal's way back; calling the tower `blocked` for a slip with no forward is `prompts/integrator.md`; returning a car whose `received` sb refused is the refusal's word (`Return it with this word`); a train the server forgot calling the tower and ending is `prompts/train.md` and spec §24.
- **The integrator's session** (the wait for a `returned` notice): code, `src/carwait.ts`. No model's judgment is in it.
- **The tower run**: it holds a slip until it forwards it, a restart included (`runtools.ts`: the slip's event is on disk, the door's answer is asked again). What it does with a `blocked` call is `prompts/tower-run.md`.
- **The coordinator**: it waits for sb's notice (`prompts/main.md`) and may send the same head again at any time.

A step an agent would have to improvise is not in the model.

## What the model leaves out

- More than one car, and more than one sender of a head. Two sessions that send the same head (a coordinator whose session was replaced by a new one) are not modeled; the newest forward decides the coordinator at receipt.
- The moment between setting a state and the first send of its notice. The model joins them into one step, since the book starts the sender in the same turn. A restart inside that moment ends as path A does, and the fix covers it the same way: the session finds the book without the car.
- The life before a new life. The server still sends the notice of that life, and the train that dropped the car still waits for it. The model follows the newest life only: its `notice` is the newest state's, and a train that still runs when a new life starts is done with the car (`Left`).
- The integrator's pi process being killed while it waits: the wait is its memory, and nothing is handed over. A session that ends in order hands the notice to the tower (`IntegEndsWaiting`).
- The tower not taking a `blocked` call. The sender and the waiting session each try ten times, 30 s apart, and then stop; with a coordinator that never comes back, nobody is told.
- A notice the server leaves undelivered for a day (the sender stops then): the waiting session hands it to the tower, which the model does not show.
- A car merged by squash or rebase. The model has "merged" or not; the real check at `received` reads the car's head on the base's branch, and a squashed car has no head there. For such a project a restart still lets a landed car be received again.
- The check at `received` not running: a project whose remote the server cannot read is received unchecked (an app whose remote is read but that names no usable base is refused, car-forward-F003).
- The tower's side of a forward: the door's answer (`namedFor`), a slip's event that is dropped after 24 h or when its run ends, and an ally run.
- The sender's own 24 h limit on a notice, the exact retry times (30 s, 2 min, 5 min are one "not delivered yet" state), and the back-off of looking for a coordinator that is away.
- The registration secret, the `landed` check against the remote beyond "merged" or not, the three failed checks that close a car, and a train reopened by a repeated open (it can drop but not land).
- The integrator's and the train's todos and guards beyond the one fact that their step waits for the notice.
- Time, other than "a day passed".

## Seen on the way, not a rule that breaks

- The #154 refusal tells the integrator to "ask the car's coordinator to send its slip to the tower again", while `prompts/integrator.md` says "never send a slip's sender a notice yourself" and names `why=blocked` for a slip with no tower forward. Either way keeps rule 1 in the model; the two texts point the integrator to different doors.
- The restart sentence is added to every "no forward" refusal while the server is younger than 24 h, also when the forward was pushed out by 512 newer ones or never existed. The way back it names is still the right one.
- A train that merged a car and then lost its server (a restart) cannot set `landed`, and with the fix of #15 the car is not received for a new train either. Its coordinator learns that the car is on the base from the `returned` notice of the slip sent again; no `landed` notice with a version follows from sb. Spec §24 says so.
