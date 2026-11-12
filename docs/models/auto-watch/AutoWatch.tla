---- MODULE AutoWatch ----
\* The head tower's auto watch (issue #16): the life of its notices from a reading to the
\* morning's return list. Actors: the watch's timer (a reading every 15 minutes), the head
\* tower's queue and its runs, the head tower itself (open, closed, opened again), the boss's
\* auto switch, and the world (a finding appears, stays, or resolves; a run crashes; the server
\* quits a run, purges a queue, or restarts; the period file goes bad).
\* Code: src/server/autowatch.ts (createAutoWatch, settle, watchSection), watchops.ts
\* (watchSwitch, noticeState), runs.ts (notice, finish, noticeState, dropNotices),
\* towerstore.ts (the queue, parkEvent, purgeQueues); docs/specs/2026-11-12-auto-watch.md.
\* `Design = "today"` is the code at 1ffea42f; `Design = "decided"` with `Fixes` is the
\* design of rules W1..W6 (README.md beside this file), each fix one entry of `Fixes`.
\* A finding stands for anything a reading can hold that is new to the head: a lasting finding,
\* a wait refused since the last wake, a quiet workspace. Time is the reading count `clock`.
EXTENDS Naturals, FiniteSets

CONSTANTS
  Findings,     \* the findings the world can show, e.g. {"a", "b"}
  Periods,      \* how many times auto mode is switched on
  MaxReadings,  \* readings per period
  MaxCrashes, MaxQuits, MaxPurges, MaxRestarts, MaxReopens, MaxBad,
  Design,       \* "today" or "decided"
  Fixes,        \* the fixes of the decided design that are in
  Mutations     \* changes the way wrong code would behave, to show a rule able to break

Has(x) == Design = "decided" /\ x \in Fixes
Mut(x) == x \in Mutations

VARIABLES
  auto,     \* "on" or "off"
  period,   \* the period that runs, or ran last (0: never on)
  clock,    \* readings taken in this period (the time of a reading)
  head,     \* the head tower: "open" or "closed"
  gen,      \* how many times the head was opened again
  present,  \* the findings the world shows now
  queue,    \* the head's queue of watch notices: [k, p, st, cr, drop, fresh]
  run,      \* the key of the notice a live head run holds, or "none"
  ledger,   \* the keys of notices a head run finished well (runs.ts `told`)
  w,        \* the watch's state in the period file
  seen,     \* ghost: the findings present at any reading of this period
  toldOk,   \* ghost: the findings a notice of this period carried to a run that ended well
  row,      \* ghost: this period's notices parked in a row since one ended well or the head opened
  used,     \* ghost: the notice keys sent in this period
  out,      \* emitted by the last step: the key it sent ("none"), what it told, whether it was
            \* sent while another notice of the period waited, and whether its key was used before
  morning,  \* emitted at the switch off: the watch's section of the return list
  fails     \* the failure steps taken, against their bounds

vars == <<auto, period, clock, head, gen, present, queue, run, ledger, w, seen, toldOk, row,
          used, out, morning, fails>>

None == [k |-> "none", fresh |-> {}]
FreshW == [wakes |-> 0, n |-> 0, pc |-> 0, inRow |-> 0, lastGen |-> 0, pend |-> None,
           shown |-> {}, untold |-> {}, parkedF |-> {}, last |-> {}, openStored |-> {}, lost |-> 0]
NoMorning == [on |-> FALSE]
NoOut == [k |-> "none", fresh |-> {}, over |-> FALSE, dup |-> FALSE]

Init ==
  /\ auto = "off" /\ period = 0 /\ clock = 0 /\ head = "open" /\ gen = 0
  /\ present = {} /\ queue = {} /\ run = "none" /\ ledger = {} /\ w = FreshW
  /\ seen = {} /\ toldOk = {} /\ row = 0 /\ used = {}
  /\ out = NoOut /\ morning = NoMorning
  /\ fails = [crash |-> 0, quit |-> 0, purge |-> 0, restart |-> 0, reopen |-> 0, bad |-> 0]

Quiet == out' = NoOut

\* ---- where a notice is (runs.ts noticeState) and what the watch makes of it (settle)

Ev(k) == CHOOSE e \in queue : e.k = k
InQueue(k) == \E e \in queue : e.k = k

\* today: a notice out of the queue and out of the parked folder is "gone", and gone counts as
\* taken. decided (Ledger): it is "told" only when its key is in the ledger a run that ended
\* well wrote; otherwise "gone" is not taken.
Where(p) ==
  IF p.k = "none" THEN "none"
  ELSE IF InQueue(p.k) THEN
    (IF Ev(p.k).st = "parked" THEN "parked" ELSE IF Ev(p.k).st = "taken" /\ run = p.k THEN "taken" ELSE "queued")
  ELSE IF ~Has("Ledger") \/ p.k \in ledger THEN "told" ELSE "gone"

Settle(s, at) ==
  CASE at \in {"none", "queued", "taken"} -> s
    [] at = "parked" ->
         [s EXCEPT !.pend = None, !.pc = s.pc + 1, !.inRow = s.inRow + 1, !.lastGen = gen,
                   !.parkedF = IF Has("Untold") THEN s.parkedF \cup s.pend.fresh ELSE s.pend.fresh]
    [] at = "told" ->
         [s EXCEPT !.pend = None, !.wakes = s.wakes + 1, !.inRow = 0,
                   !.shown = s.shown \cup s.pend.fresh, !.untold = s.untold \ s.pend.fresh,
                   !.parkedF = IF Has("Untold") THEN s.parkedF \ s.pend.fresh ELSE s.parkedF]
    [] at = "gone" -> [s EXCEPT !.pend = None, !.lost = s.lost + 1]

\* The key of the n-th notice: today wakes + parked + 1; decided, the count of notices sent
\* (KeyCounter) and the reading's time (KeyTime).
KeyOf(s) ==
  <<period, IF Has("KeyCounter") THEN s.n + 1 ELSE s.wakes + s.pc + 1, IF Has("KeyTime") THEN clock ELSE 0>>

\* ---- the boss's switch

AutoOn ==
  /\ auto = "off" /\ period < Periods
  /\ auto' = "on" /\ period' = period + 1 /\ clock' = 0 /\ w' = FreshW
  /\ seen' = {} /\ toldOk' = {} /\ row' = 0 /\ used' = {} /\ morning' = NoMorning
  /\ Quiet
  /\ UNCHANGED <<head, gen, present, queue, run, ledger, fails>>

\* The return list is built first (automode.ts switchOff), then the switch's listeners drop
\* the period's notices (watchops.ts watchSwitch).
Morning ==
  LET at == Where(w.pend)
      s == Settle(w, at)
      pf == IF at \in {"queued", "taken"} THEN w.pend.fresh ELSE {}
      inFlight == IF at = "taken" THEN w.pend.fresh ELSE {}
      parkedP == IF Has("Untold") THEN s.parkedF \ pf ELSE s.parkedF
      untaken == IF Has("Untold") THEN (s.untold \ inFlight) \ parkedP
                 ELSE IF at = "queued" THEN w.pend.fresh ELSE {}
      gone == IF Has("Untold") THEN s.untold ELSE pf \cup (IF at = "parked" THEN w.pend.fresh ELSE {})
      open == (IF Has("MorningOpen") THEN s.last ELSE s.openStored) \ gone
  IN [on |-> TRUE, seen |-> seen, told |-> s.shown, toldOk |-> toldOk, last |-> s.last,
      inFlight |-> inFlight, untaken |-> untaken, parked |-> parkedP, open |-> open]

Drops(e) == e.st \in {"queued", "parked"} /\ (Has("DropHead") \/ head = "open")

AutoOff ==
  /\ auto = "on"
  /\ auto' = "off" /\ morning' = Morning
  /\ queue' = { IF e.st = "taken" /\ run = e.k /\ Has("DropMark") THEN [e EXCEPT !.drop = TRUE] ELSE e :
                e \in { x \in queue : ~Drops(x) } }
  /\ Quiet
  /\ UNCHANGED <<period, clock, head, gen, present, run, ledger, w, seen, toldOk, row, used, fails>>

\* ---- the world

Appears(f) ==
  /\ f \notin present /\ present' = present \cup {f} /\ Quiet
  /\ UNCHANGED <<auto, period, clock, head, gen, queue, run, ledger, w, seen, toldOk, row, used, morning, fails>>

Resolves(f) ==
  /\ f \in present /\ present' = present \ {f} /\ Quiet
  /\ UNCHANGED <<auto, period, clock, head, gen, queue, run, ledger, w, seen, toldOk, row, used, morning, fails>>

\* ---- the watch's reading (createAutoWatch tick)

Waiting == { e \in queue : e.p = period /\ e.st \in {"queued", "taken"} /\ ~e.drop }

Reading ==
  /\ auto = "on" /\ clock < MaxReadings
  /\ LET s0 == Settle(w, Where(w.pend))
         \* decided (CrashBound): the head that closed, or opened again, ends the row of parks
         s1 == IF Has("CrashBound") /\ (head = "closed" \/ gen # s0.lastGen) THEN [s0 EXCEPT !.inRow = 0] ELSE s0
         fresh == present \ s1.shown
         \* the watch's own mark of its last notice, and the head's queue asked (runs.noticeWaits):
         \* today a notice no run took; decided (WaitAll), also one a live run holds
         blocked == s1.pend.k # "none" /\ ~Mut("NoPendingCheck")
         waits == ~Mut("NoWaitGuard") /\ \E e \in queue : ~e.drop /\ (e.st = "queued" \/ (Has("WaitAll") /\ e.st = "taken" /\ run = e.k))
         hot == fresh # {} \/ Mut("SendCalm")
         bound == Has("CrashBound") /\ s1.inRow >= 2
         go == ~blocked /\ ~waits /\ hot /\ head = "open" /\ ~bound
         k == KeyOf(s1)
         s2 == [s1 EXCEPT !.last = present,
                          !.untold = IF Has("Untold") THEN s1.untold \cup fresh ELSE {},
                          !.openStored = present \ (IF go THEN fresh ELSE s1.pend.fresh)]
     IN /\ w' = IF go THEN [s2 EXCEPT !.pend = [k |-> k, fresh |-> fresh], !.n = s1.n + 1] ELSE s2
        /\ queue' = IF go THEN queue \cup {[k |-> k, p |-> period, st |-> "queued", cr |-> 0, drop |-> FALSE, fresh |-> fresh]} ELSE queue
        /\ out' = IF go THEN [k |-> k, fresh |-> fresh, over |-> Waiting # {}, dup |-> k \in used \/ InQueue(k)] ELSE NoOut
        /\ used' = IF go THEN used \cup {k} ELSE used
  /\ clock' = clock + 1 /\ seen' = seen \cup present
  /\ UNCHANGED <<auto, period, head, gen, present, run, ledger, toldOk, row, morning, fails>>

\* ---- the head's runs (runs.ts)

RunTakes ==
  /\ head = "open" /\ run = "none"
  /\ \E e \in queue :
       /\ e.st = "queued" /\ ~e.drop
       /\ run' = e.k /\ queue' = (queue \ {e}) \cup {[e EXCEPT !.st = "taken"]}
  /\ Quiet
  /\ UNCHANGED <<auto, period, clock, head, gen, present, ledger, w, seen, toldOk, row, used, morning, fails>>

Held == Ev(run)
Current(e) == e.p = period /\ auto = "on"

RunEndsOk ==
  /\ run # "none" /\ run' = "none" /\ queue' = queue \ {Held}
  /\ ledger' = ledger \cup {run}
  /\ toldOk' = IF Current(Held) THEN toldOk \cup Held.fresh ELSE toldOk
  /\ row' = IF Current(Held) THEN 0 ELSE row
  /\ Quiet
  /\ UNCHANGED <<auto, period, clock, head, gen, present, w, seen, used, morning, fails>>

\* finish(crashed): a second crash parks the event; decided (DropMark), an event of a period
\* that ended goes instead.
RunCrashes ==
  /\ run # "none" /\ fails.crash < MaxCrashes
  /\ LET e == Held
         parks == e.cr + 1 >= 2
     IN /\ queue' = IF Has("DropMark") /\ e.drop THEN queue \ {e}
                    ELSE (queue \ {e}) \cup {[e EXCEPT !.st = IF parks THEN "parked" ELSE "queued", !.cr = e.cr + 1]}
        /\ row' = IF parks /\ Current(e) /\ ~e.drop THEN row + 1 ELSE row
  /\ run' = "none" /\ fails' = [fails EXCEPT !.crash = @ + 1]
  /\ Quiet
  /\ UNCHANGED <<auto, period, clock, head, gen, present, ledger, w, seen, toldOk, used, morning>>

\* finish(quit): the server ended the run (the head's tab was closed, the service detached,
\* the session replaced); the event it held is removed as if done.
RunQuit ==
  /\ run # "none" /\ fails.quit < MaxQuits
  /\ run' = "none" /\ queue' = queue \ {Held} /\ fails' = [fails EXCEPT !.quit = @ + 1]
  /\ Quiet
  /\ UNCHANGED <<auto, period, clock, head, gen, present, ledger, w, seen, toldOk, row, used, morning>>

\* The server stops with a run in flight (finish with keepTaken): the event goes back to the
\* queue, uncounted; decided (DropMark), an event of a period that ended goes instead.
Restart ==
  /\ fails.restart < MaxRestarts /\ fails' = [fails EXCEPT !.restart = @ + 1]
  /\ run' = "none"
  /\ queue' = IF run = "none" THEN queue
              ELSE IF Has("DropMark") /\ Held.drop THEN queue \ {Held}
              ELSE (queue \ {Held}) \cup {[Held EXCEPT !.st = "queued"]}
  /\ Quiet
  /\ UNCHANGED <<auto, period, clock, head, gen, present, ledger, w, seen, toldOk, row, used, morning>>

\* purgeQueues: an event older than 24 h, queued or parked, goes.
Purge ==
  /\ fails.purge < MaxPurges /\ fails' = [fails EXCEPT !.purge = @ + 1]
  /\ \E e \in queue : e.st \in {"queued", "parked"} /\ queue' = queue \ {e}
  /\ Quiet
  /\ UNCHANGED <<auto, period, clock, head, gen, present, run, ledger, w, seen, toldOk, row, used, morning>>

\* ---- the head tower

\* The boss closes the head (or its tab is lost): its run is quit, its queue stays on disk.
HeadCloses ==
  /\ head = "open" /\ fails.reopen < MaxReopens
  /\ head' = "closed" /\ run' = "none"
  /\ queue' = IF run = "none" THEN queue ELSE queue \ {Held}
  /\ Quiet
  /\ UNCHANGED <<auto, period, clock, gen, present, ledger, w, seen, toldOk, row, used, morning, fails>>

\* A head opened again binds the same folder, queue and all.
HeadOpens ==
  /\ head = "closed"
  /\ head' = "open" /\ gen' = gen + 1 /\ row' = 0 /\ fails' = [fails EXCEPT !.reopen = @ + 1]
  /\ Quiet
  /\ UNCHANGED <<auto, period, clock, present, queue, run, ledger, w, seen, toldOk, used, morning>>

\* ---- the period file

\* A hand edit breaks `parked.items` or `parked.at`: today watchOf drops `parked`, its count
\* with it; decided (KeepCount) keeps the count.
ParkedFieldBad ==
  /\ auto = "on" /\ fails.bad < MaxBad /\ w.pc > 0
  /\ w' = IF Has("KeepCount") THEN w ELSE [w EXCEPT !.pc = 0]
  /\ fails' = [fails EXCEPT !.bad = @ + 1]
  /\ Quiet
  /\ UNCHANGED <<auto, period, clock, head, gen, present, queue, run, ledger, seen, toldOk, row, used, morning>>

\* The period file cannot be read after a restart: the watch starts the period's count again.
StateLost ==
  /\ auto = "on" /\ fails.bad < MaxBad /\ w # FreshW
  /\ w' = FreshW /\ fails' = [fails EXCEPT !.bad = @ + 1]
  /\ Quiet
  /\ UNCHANGED <<auto, period, clock, head, gen, present, queue, run, ledger, seen, toldOk, row, used, morning>>

Next ==
  \/ AutoOn \/ AutoOff \/ Reading
  \/ \E f \in Findings : Appears(f) \/ Resolves(f)
  \/ RunTakes \/ Purge
  \/ RunEndsOk \/ RunCrashes \/ RunQuit \/ Restart
  \/ HeadCloses \/ HeadOpens
  \/ ParkedFieldBad \/ StateLost

Spec == Init /\ [][Next]_vars

\* ---- the rules

\* W1. A notice counts as told only when a head run that took it ended well.
ToldOnlyWhenTaken ==
  /\ w.shown \subseteq toldOk
  /\ morning.on => morning.told \subseteq morning.toldOk

\* W2. At most one notice of the watch waits at a time.
OneWaits == Cardinality(Waiting) <= 1

\* W2. No notice of a period survives its switch off: one a live run holds may finish, and
\* nothing else of an ended period is left to be offered to a head opened later.
NoStaleNotice ==
  \A e \in queue : (e.p # period \/ auto = "off") => (e.st = "taken" /\ run = e.k)

\* W3. Every finding seen at a reading of the period is on the morning list in exactly one
\* place (in flight, not taken, parked, still open), unless it was told and has resolved.
Places(m, f) == {x \in {"inFlight", "untaken", "parked", "open"} : f \in m[x]}
MorningWhole ==
  morning.on =>
    \A f \in Findings :
      LET n == Cardinality(Places(morning, f))
      IN IF f \in morning.seen /\ ~(f \in morning.told /\ f \notin morning.last) THEN n = 1 ELSE n <= 1

\* W4. After two notices parked in a row, no new notice until one ends well or the head is
\* opened again.
CrashBound == out.k # "none" => row < 2

\* W5. A notice key is never used twice in a period.
KeysUnique == ~out.dup

\* W6. A wake never sends over a notice that still waits, and never for a calm reading.
NoSendOver == ~out.over
NeverCalm == out.k # "none" => out.fresh # {}
====
