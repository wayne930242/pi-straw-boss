---- MODULE CarForward ----
\* One car (one head) from its coordinator's slip to what its coordinator learns of it.
\* Actors: the coordinator, the tower run, the integrator, the train, the sb server (its
\* book of forwards, cars, notices and trains is memory only), and the world (a restart,
\* a day passing, the coordinator's session leaving).
\* Code: src/server/carbook.ts, carnotices.ts, runtools.ts, trainnote.ts, src/traincar.ts,
\* src/train/cars.ts; docs/specs/2026-11-07-train-workers.md §5.5 and §24.
\* What an agent does is taken from its prompt (prompts/integrator.md, train.md, main.md)
\* or from the words of a refusal; report.md beside this file lists what is left out.
EXTENDS Naturals

CONSTANTS MaxSlips, MaxRestarts, MaxDays, MaxTrains

VARIABLES
  slips,      \* slips the coordinator sent the tower for this head
  named,      \* whom the slip names as coordinator: "self" (its sender) or "other"
  towerHas,   \* the tower run holds a slip it has not forwarded yet
  coord,      \* the coordinator's session: "here" or "away" (not live)
  knows,      \* the last thing the coordinator was told of the car
  toldLanded, \* how many `landed` notices reached the coordinator
  towerTold,  \* the tower was told (a `blocked` call) of the car's present trouble
  integ,      \* the integrator: "idle", "slip" (holds a slip to decide), "waits"
              \* (set received, its train todo waits for the notice), "rides", "done"
  fwd,        \* server memory: the tower's forward of this head, "held" or "none"
  book,       \* server memory: the car's state
  notice,     \* server memory: the notice of that state
  noticeTo,   \* the session the notice of that state is addressed to
  train,      \* "none", "open", "forgotten" (it runs, the server lost it), "blocked", "ended"
  trains,     \* trains opened for this car
  merged,     \* the car's commit is on the base's remote branch
  restarts,
  days,
  upLong      \* the server has been up for 24 h or more

vars == <<slips, named, towerHas, coord, knows, toldLanded, towerTold, integ, fwd, book,
          notice, noticeTo, train, trains, merged, restarts, days, upLong>>

Terminal == {"returned", "dropped", "landed"}

Init ==
  /\ slips = 0 /\ named = "self" /\ towerHas = FALSE
  /\ coord = "here" /\ knows = "nothing" /\ toldLanded = 0 /\ towerTold = FALSE
  /\ integ = "idle" /\ fwd = "none" /\ book = "none" /\ notice = "none" /\ noticeTo = "nobody"
  /\ train = "none" /\ trains = 0 /\ merged = FALSE
  /\ restarts = 0 /\ days = 0 /\ upLong = FALSE

\* Setting a state and the first send of its notice are one step here: the book kicks the
\* sender in the same turn (carbook.ts `queueMicrotask(onChange)`), so nothing else is let
\* in between. The real gap is a few milliseconds.
Sending == notice = "due"

\* ---- the coordinator

CoordSends ==
  /\ ~Sending /\ coord = "here" /\ slips = 0
  /\ slips' = 1 /\ towerHas' = TRUE
  /\ named' \in {"self", "other"}
  /\ UNCHANGED <<coord, knows, toldLanded, towerTold, integ, fwd, book, notice, noticeTo,
                 train, trains, merged, restarts, days, upLong>>

\* The same head again, its slip put right: asked for (knows = "resend"), after the car came
\* back (returned, dropped), or of its own accord. After a car came back the coordinator
\* waits for a new answer; one that was told received or landed still knows that.
CoordSendsAgain ==
  /\ ~Sending /\ coord = "here" /\ slips >= 1 /\ slips < MaxSlips
  /\ slips' = slips + 1 /\ towerHas' = TRUE /\ named' = "self"
  /\ knows' = IF knows \in {"resend", "returned", "dropped"} THEN "nothing" ELSE knows
  /\ towerTold' = FALSE
  /\ UNCHANGED <<coord, toldLanded, integ, fwd, book, notice, noticeTo,
                 train, trains, merged, restarts, days, upLong>>

CoordLeaves ==
  /\ ~Sending /\ coord = "here" /\ coord' = "away"
  /\ UNCHANGED <<slips, named, towerHas, knows, toldLanded, towerTold, integ, fwd, book,
                 notice, noticeTo, train, trains, merged, restarts, days, upLong>>

CoordReturns ==
  /\ ~Sending /\ coord = "away" /\ coord' = "here"
  /\ UNCHANGED <<slips, named, towerHas, knows, toldLanded, towerTold, integ, fwd, book,
                 notice, noticeTo, train, trains, merged, restarts, days, upLong>>

\* ---- the tower run: runtools.ts posts the slip to the integrator, then `noteForward`

TowerForwards ==
  /\ ~Sending /\ towerHas
  /\ towerHas' = FALSE /\ fwd' = "held"
  /\ integ' = IF book = "received" THEN integ ELSE "slip"
  /\ UNCHANGED <<slips, named, coord, knows, toldLanded, towerTold, book, notice, noticeTo,
                 train, trains, merged, restarts, days, upLong>>

\* ---- the integrator (train_car received / returned; carbook.ts setNow, role main)

IntegReceives ==
  /\ ~Sending /\ integ \in {"slip", "waits"} /\ book = "none" /\ fwd = "held"
  /\ named = "self"            \* a slip that names another session is refused at received
  /\ book' = "received" /\ notice' = "due" /\ noticeTo' = "sender"
  /\ integ' = "waits" /\ towerTold' = FALSE
  /\ UNCHANGED <<slips, named, towerHas, coord, knows, toldLanded, fwd, train, trains,
                 merged, restarts, days, upLong>>

\* Returned at receipt. A slip that names another session goes back to the session that
\* really sent it (carbook.ts `coordinator: sent.from`).
IntegReturns ==
  /\ ~Sending /\ integ = "slip" /\ book = "none" /\ fwd = "held"
  /\ book' = "returned" /\ notice' = "due" /\ noticeTo' = "sender"
  /\ integ' = "done" /\ towerTold' = FALSE
  /\ UNCHANGED <<slips, named, towerHas, coord, knows, toldLanded, fwd, train, trains,
                 merged, restarts, days, upLong>>

\* "no forward by a tower carries head ..." within 24 h of the server's start: the refusal
\* names the restart and the way back (todo #154), and the integrator passes it on.
IntegAsksResend ==
  /\ ~Sending /\ integ \in {"slip", "waits"} /\ book = "none" /\ fwd = "none"
  /\ ~upLong /\ coord = "here"
  /\ knows' = "resend" /\ integ' = "idle"
  /\ UNCHANGED <<slips, named, towerHas, coord, toldLanded, towerTold, fwd, book, notice,
                 noticeTo, train, trains, merged, restarts, days, upLong>>

\* The same refusal with no way back named (the server is up 24 h or more), or a
\* coordinator that is not live: prompts/integrator.md says `why=blocked` naming the car.
IntegCallsTower ==
  /\ ~Sending /\ integ \in {"slip", "waits"} /\ book = "none" /\ fwd = "none"
  /\ upLong \/ coord = "away"
  /\ towerTold' = TRUE /\ integ' = "idle"
  /\ UNCHANGED <<slips, named, towerHas, coord, knows, toldLanded, fwd, book, notice,
                 noticeTo, train, trains, merged, restarts, days, upLong>>

\* "car ... is already returned / dropped / landed": a second slip of a head that ended in
\* this server's life. No state can be set for it, so sb sends nothing, and the integrator's
\* prompt names no call for this refusal.
IntegAlready ==
  /\ ~Sending /\ integ = "slip" /\ book \in Terminal
  /\ integ' = "done"
  /\ UNCHANGED <<slips, named, towerHas, coord, knows, toldLanded, towerTold, fwd, book,
                 notice, noticeTo, train, trains, merged, restarts, days, upLong>>

\* The integrator's train todo passes once the received notice is told (delivered, or
\* escalated to the tower), its manifest goes to the tower, and the tower opens the train.
TrainOpens ==
  /\ ~Sending /\ integ = "waits" /\ book = "received" /\ notice \in {"told", "escalated"}
  /\ trains < MaxTrains /\ train # "open"
  /\ integ' = "rides" /\ train' = "open" /\ trains' = trains + 1
  /\ UNCHANGED <<slips, named, towerHas, coord, knows, toldLanded, towerTold, fwd, book,
                 notice, noticeTo, merged, restarts, days, upLong>>

\* ---- the train (train_car dropped / landed; carbook.ts setNow, role train)

\* The train pushes the merge itself; the server has no part in it.
TrainMerges ==
  /\ ~Sending /\ ~merged
  /\ (train = "open" /\ book = "received") \/ train = "forgotten"
  /\ merged' = TRUE
  /\ UNCHANGED <<slips, named, towerHas, coord, knows, toldLanded, towerTold, integ, fwd,
                 book, notice, noticeTo, train, trains, restarts, days, upLong>>

TrainLands ==
  /\ ~Sending /\ train = "open" /\ book = "received" /\ merged
  /\ book' = "landed" /\ notice' = "due" /\ noticeTo' = "sender" /\ towerTold' = FALSE
  /\ UNCHANGED <<slips, named, towerHas, coord, knows, toldLanded, integ, fwd, train, trains,
                 merged, restarts, days, upLong>>

\* Dropped from a round, or returned from the manifest: the car leaves the train unmerged.
TrainDrops ==
  /\ ~Sending /\ train = "open" /\ book = "received" /\ ~merged
  /\ book' = "dropped" /\ notice' = "due" /\ noticeTo' = "sender" /\ towerTold' = FALSE
  /\ UNCHANGED <<slips, named, towerHas, coord, knows, toldLanded, integ, fwd, train, trains,
                 merged, restarts, days, upLong>>

\* `land` and the assemble that removes a car pass once the notice is told.
TrainEnds ==
  /\ ~Sending /\ train = "open" /\ book \in {"landed", "dropped"} /\ notice \in {"told", "escalated"}
  /\ train' = "ended" /\ integ' = IF integ = "rides" THEN "done" ELSE integ
  /\ UNCHANGED <<slips, named, towerHas, coord, knows, toldLanded, towerTold, fwd, book,
                 notice, noticeTo, trains, merged, restarts, days, upLong>>

\* After a restart: "this server did not open train ...". prompts/train.md: `blocked` for
\* what needs a person, then end. The boss decides (§24).
TrainBlocked ==
  /\ ~Sending /\ train = "forgotten"
  /\ train' = "blocked" /\ towerTold' = TRUE
  /\ UNCHANGED <<slips, named, towerHas, coord, knows, toldLanded, integ, fwd, book, notice,
                 noticeTo, trains, merged, restarts, days, upLong>>

\* ---- the server's sender of notices (carnotices.ts)

NoticeDelivered ==
  /\ notice \in {"due", "retrying", "escalated"} /\ coord = "here"
  /\ notice' = "told" /\ knows' = book /\ towerTold' = FALSE
  /\ toldLanded' = IF book = "landed" THEN toldLanded + 1 ELSE toldLanded
  /\ UNCHANGED <<slips, named, towerHas, coord, integ, fwd, book, noticeTo, train,
                 trains, merged, restarts, days, upLong>>

\* The broker answers queued, failed or unknown: tried again at 30 s, 2 min and 5 min.
SendFails ==
  /\ notice = "due" /\ coord = "here"
  /\ notice' = "retrying"
  /\ UNCHANGED <<slips, named, towerHas, coord, knows, toldLanded, towerTold, integ, fwd,
                 book, noticeTo, train, trains, merged, restarts, days, upLong>>

\* The retries are spent, or the coordinator is not live at an attempt: one `blocked` call
\* to the tower. A coordinator that comes back is still told (NoticeDelivered).
TowerToldInstead ==
  /\ \/ notice = "retrying"
     \/ notice = "due" /\ coord = "away"
  /\ notice' = "escalated" /\ towerTold' = TRUE
  /\ UNCHANGED <<slips, named, towerHas, coord, knows, toldLanded, integ, fwd, book,
                 noticeTo, train, trains, merged, restarts, days, upLong>>

\* ---- the world

\* The server starts again with an empty book: no forward, no car, no notice, no train.
\* The journal on disk is not read back (CR-F003).
Restart ==
  /\ ~Sending /\ restarts < MaxRestarts
  /\ restarts' = restarts + 1 /\ upLong' = FALSE
  /\ fwd' = "none" /\ book' = "none" /\ notice' = "none" /\ noticeTo' = "nobody"
  /\ train' = IF train = "open" THEN "forgotten" ELSE train
  /\ UNCHANGED <<slips, named, towerHas, coord, knows, toldLanded, towerTold, integ, trains,
                 merged, days>>

\* 24 h go by: a forward is kept for KEEP_MS, and the refusal names the restart for KEEP_MS
\* after the server's start. The retries of a notice are over long before.
DayPasses ==
  /\ ~Sending /\ days < MaxDays /\ notice # "retrying"
  /\ days' = days + 1 /\ upLong' = TRUE /\ fwd' = "none"
  /\ UNCHANGED <<slips, named, towerHas, coord, knows, toldLanded, towerTold, integ, book,
                 notice, noticeTo, train, trains, merged, restarts>>

\* MAX_FORWARDS: 512 newer forwards push this one out before the integrator acts on it.
ForwardPushedOut ==
  /\ ~Sending /\ fwd = "held" /\ book = "none"
  /\ fwd' = "none"
  /\ UNCHANGED <<slips, named, towerHas, coord, knows, toldLanded, towerTold, integ, book,
                 notice, noticeTo, train, trains, merged, restarts, days, upLong>>

Next ==
  \/ CoordSends \/ CoordSendsAgain \/ CoordLeaves \/ CoordReturns
  \/ TowerForwards
  \/ IntegReceives \/ IntegReturns \/ IntegAsksResend \/ IntegCallsTower \/ IntegAlready
  \/ TrainOpens \/ TrainMerges \/ TrainLands \/ TrainDrops \/ TrainEnds \/ TrainBlocked
  \/ NoticeDelivered \/ SendFails \/ TowerToldInstead
  \/ Restart \/ DayPasses \/ ForwardPushedOut

Spec == Init /\ [][Next]_vars

\* ---- the rules

TypeOK ==
  /\ slips \in 0..MaxSlips /\ named \in {"self", "other"} /\ towerHas \in BOOLEAN
  /\ coord \in {"here", "away"}
  /\ knows \in {"nothing", "received", "returned", "dropped", "landed", "resend"}
  /\ toldLanded \in 0..MaxTrains /\ towerTold \in BOOLEAN
  /\ integ \in {"idle", "slip", "waits", "rides", "done"}
  /\ fwd \in {"none", "held"}
  /\ book \in {"none", "received", "returned", "dropped", "landed"}
  /\ notice \in {"none", "due", "retrying", "escalated", "told"}
  /\ noticeTo \in {"nobody", "sender", "other"}
  /\ train \in {"none", "open", "forgotten", "blocked", "ended"}
  /\ trains \in 0..MaxTrains /\ merged \in BOOLEAN
  /\ restarts \in 0..MaxRestarts /\ days \in 0..MaxDays /\ upLong \in BOOLEAN

\* Somebody still has a step to take for the car without a new slip from its coordinator.
Busy ==
  \/ towerHas
  \/ integ \in {"slip", "waits"}
  \/ notice \in {"due", "retrying"}
  \/ train \in {"open", "forgotten"}

\* Proposed rule 1. Every slip the tower forwarded ends with its coordinator knowing the
\* car's outcome or knowing it must send the slip again; when the coordinator could not be
\* told, the tower was told instead.
NoCarLeftInTheDark ==
  (slips > 0 /\ ~Busy) => (knows \in Terminal \/ knows = "resend" \/ towerTold)

\* Proposed rule 2. A car is never landed twice: its coordinator is told `landed` at most once.
LandedToldOnce == toldLanded <= 1

\* Proposed rule 3. A notice never names a car its coordinator did not send: it goes to the
\* session that sent the slip, whoever the slip names.
NoticeToSender == noticeTo # "other"
====
