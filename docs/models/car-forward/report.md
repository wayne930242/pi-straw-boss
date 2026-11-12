# The car model: from a coordinator's slip to what the coordinator learns

A TLA+ model of one car (one head) on its way from its coordinator's slip, through the tower's forward and the integrator's `train_car`, to the notices the sb server sends back. TLC checks three rules on every path the model allows, including a server restart, a day passing, a forward pushed out, a second slip of the same head, a notice that is not delivered, and a coordinator whose session is gone.

The rules are **proposed**: the boss, who runs coordinators and trains, has not confirmed them yet. Checked on `191ccfa1` (0.76.0) on 2026-11-12. Nothing was fixed; each rule that breaks has a replay test in `tests/model-car-forward.test.ts` that is red on this commit.

## Result

| Rule (proposed) | In the model | Result |
| --- | --- | --- |
| 1. Every slip the tower forwarded ends with its coordinator knowing the car's outcome or knowing it must send the slip again; when the coordinator could not be told, the tower was told instead. | `NoCarLeftInTheDark` | **Breaks**, two causes (A, B) |
| 2. A car is never landed twice: its coordinator is told `landed` at most once. | `LandedToldOnce` | **Breaks**, one cause (C) |
| 3. A notice never names a car its coordinator did not send: it goes to the session that sent the slip, whoever the slip names. | `NoticeToSender` | Holds |

## The files

| File | What it is |
| --- | --- |
| `CarForward.tla` | The model: the steps of each actor and the three rules. |
| `CarForward.cfg` | The full check: 2 slips, 1 restart, 1 day, 2 trains. 5,938 states. |
| `NoRestart.cfg` | The same with no restart, so the causes a restart hides show. 1,168 states. |
| `Lifecycle.cfg` | 1 slip, no restart, no day: small enough to draw whole. 94 states. |
| `view.mjs`, `view-lifecycle.mjs` | The reader's words for each state and step. |
| `check/full`, `check/no-restart`, `check/lifecycle` | What the command wrote: `chart.mmd` and `report.md` of each check. |

Run a check again (each takes 3 to 6 seconds; `--out` takes a new or empty folder, so remove the old one first):

```sh
cd docs/models/car-forward && rm -r check/full
<statechart skill>/scripts/statechart CarForward.tla --view view.mjs --out check/full
<statechart skill>/scripts/statechart CarForward.tla --config NoRestart.cfg --view view.mjs --out check/no-restart
<statechart skill>/scripts/statechart CarForward.tla --config Lifecycle.cfg --view view-lifecycle.mjs --out check/lifecycle
```

The command also writes `tlc.out` (TLC's own output, with times and paths of the computer it ran on); it is not kept here.

## Bug paths

Each path is the shortest one TLC found, in the words of `view.mjs`.

### A. Rule 1: a restart loses the notice of a car the integrator returned

From `check/full/report.md`:

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

The integrator's `returned` at receipt is the one state nobody waits for. A `received` notice holds the integrator's `train` todo, and a `dropped` or `landed` notice holds the train's step, so after a restart the integrator or the train finds the empty book and calls for help. Nothing depends on a `returned` at receipt: the integrator set it and went on, the retry at 30 s was in the memory the restart wiped, and the journal on disk is not read back (CR-F003). The coordinator waits for a notice that no one will send, and the tower is not told.

A scratch copy of the model in which a restart tells the tower of exactly this case (an undelivered `returned` at receipt), and of cause B, keeps rule 1 with 3 slips and 2 restarts (36,584 states). So within the model these two are the only causes.

Replay: `car model, NoCarLeftInTheDark: a car the integrator returned still ends with its coordinator or the tower told, when the sb server restarts before the notice was delivered`.

### B. Rule 1: the same head sent again after it came back gets no answer

From `check/no-restart/report.md`:

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

A car file is named after the app and the head and takes one terminal state, and the book never drops a car while the server runs. A car that was returned for its slip, not its code, comes back with the same head: the slip named no accept evidence, or it named a coordinator that was not its sender (the word sb itself writes for that case tells the sender so). The tower forwards the corrected slip, and sb refuses both `received` and `returned` with `sb: car T-15 is already returned`. No state can be set, so no notice is sent, and the coordinator waits for sb's notice as its prompt tells it to. The same holds after `dropped`. The head can be received again only after the server restarts, or with a new commit.

What the integrator does with that refusal is not in the code or in its prompt; the model takes it that the integrator goes on to its next slip. An integrator that calls the tower of its own accord keeps the rule, by its judgment and not by sb.

Replay: `car model, NoCarLeftInTheDark: a slip sent again for a car that was returned gets an answer from sb, to its coordinator or to the tower`.

### C. Rule 2: after a restart a landed car can be received, ridden and landed again

From `check/full/report.md`:

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

What stops a second receipt and a second terminal state is the car file in the server's memory. After a restart the book is empty, so a forward of the same head is received as a new car, and a second train lands it: the `landed` check only asks whether the commit is on the base's remote branch, which it already is. In the replay sb accepts `landed` twice with two versions (`1.2.0`, then `1.3.0`) and tells the coordinator both.

The spec accepts part of this (`docs/specs/2026-11-07-train-workers.md` §5.5: "a state set again after it is sent again; a coordinator may then see a notice twice", and §24: "a state set again after a restart is told again"). It speaks of a notice told twice, not of a car that rides and lands on a second train. The rule and the spec disagree here, and the boss chooses between them. With no restart the rule holds (`check/no-restart`).

Replay: `car model, LandedToldOnce: the coordinator of a car is told landed once, when its slip is forwarded again after the sb server restarted`.

## The replay tests are red on this commit

`npm run test:one -- tests/model-car-forward.test.ts` on `191ccfa1` plus this branch's files:

```
✖ car model, NoCarLeftInTheDark: a car the integrator returned still ends with its coordinator or the tower told, when the sb server restarts before the notice was delivered (9.758458ms)
✖ car model, LandedToldOnce: the coordinator of a car is told landed once, when its slip is forwarded again after the sb server restarted (859.522291ms)
✖ car model, NoCarLeftInTheDark: a slip sent again for a car that was returned gets an answer from sb, to its coordinator or to the tower (6.315ms)
ℹ tests 3
ℹ pass 0
ℹ fail 3

  AssertionError [ERR_ASSERTION]: the coordinator sess-coord-1 was never told its car T-15 is returned, and the tower was never told that it could not be: after the restart sb sent 0 message(s), and its book holds 0 car(s) and 0 pending notice(s)

  AssertionError [ERR_ASSERTION]: the coordinator sess-coord-1 was told landed 2 times for one car (landed in 1.2.0, your commit is 86fe1d825a5b9f125f3263a5c0e8e994b2469c9e / landed in 1.3.0, your commit is 86fe1d825a5b9f125f3263a5c0e8e994b2469c9e); after the restart, received was: Car T-15 is received; landed was: Car T-15 is landed

  AssertionError [ERR_ASSERTION]: the coordinator sess-coord-1 sent head aaaaaaaaaaaa again and sb told nobody anything of it: received was refused (sb: car T-15 is already returned); returned was refused (sb: car T-15 is already returned); sb sent 0 message(s) after the second forward
```

All three paths reproduced on the real `CarBook`, `CarNotices` and `train_car` at the first run; none needed a change to the model. Each test asserts the rule at the end of its path and treats a step that a fix may refuse as an attempt, so a fix that refuses the step, or answers it, turns the test green. While they are red, `npm test` on this branch is red: the branch is for the model and these tests and is not to be merged as it is.

## The rule that holds

Rule 3 holds because the book takes a car's coordinator from the stamp the tower's code wrote on the forward (`sent.from`), never from the slip. The model has one sender, so the rule is checked weakly: it can break only where the integrator returns a slip that names another session. To see that the check is live, a scratch copy addressed that notice to the session the slip names; TLC broke the rule in 3 steps. The real code for the same case is covered by an existing test (`tests/train-car.test.ts`, "returned at receipt: a slip whose coordinator is not its sender is returned to the sender").

## Where each actor's steps come from

- **The sb server** (book, sender, restart): the code, `src/server/carbook.ts` and `src/server/carnotices.ts`.
- **The integrator and the train**: what `train_car` lets through (`src/traincar.ts`, `carbook.ts`), and for what they do after a refusal, their prompts and the refusal's own words. Asking the coordinator to send again is the #154 refusal's way back; calling the tower `blocked` for a slip with no forward is `prompts/integrator.md`; a train the server forgot calling the tower and ending is `prompts/train.md` and spec §24.
- **The tower run**: it holds a slip until it forwards it, a restart included (`runtools.ts`: the slip's event is on disk, the door's answer is asked again).
- **The coordinator**: it waits for sb's notice (`prompts/main.md`) and may send the same head again at any time.

A step an agent would have to improvise is not in the model.

## What the model leaves out

- More than one car, and more than one sender of a head. Two sessions that send the same head (a coordinator whose session was replaced by a new one) are not modeled; the newest forward decides the coordinator at receipt.
- The moment between setting a state and the first send of its notice. The model joins them into one step, since the book starts the sender in the same turn; a restart inside that moment loses the notice the same way path A does.
- The tower's side of a forward: the door's answer (`namedFor`), a slip's event that is dropped after 24 h or when its run ends, and an ally run.
- The tower not taking the `blocked` call. The sender tries ten times, 30 s apart, and then stops; with a coordinator that never comes back, nobody is told.
- The sender's own 24 h limit on a notice, the exact retry times (30 s, 2 min, 5 min are one "not delivered yet" state), and the back-off of looking for a coordinator that is away.
- The registration secret, the `landed` check against the remote (the model has "merged" or not), the three failed checks that close a car, and a train reopened by a repeated open (it can drop but not land).
- The integrator's and the train's todos and guards beyond the one fact that their step waits for the notice.
- Time, other than "a day passed".

## Seen on the way, not a rule that breaks

- The #154 refusal tells the integrator to "ask the car's coordinator to send its slip to the tower again", while `prompts/integrator.md` says "never send a slip's sender a notice yourself" and names `why=blocked` for a slip with no tower forward. Either way keeps rule 1 in the model; the two texts point the integrator to different doors.
- The restart sentence is added to every "no forward" refusal while the server is younger than 24 h, also when the forward was pushed out by 512 newer ones or never existed. The way back it names is still the right one.
