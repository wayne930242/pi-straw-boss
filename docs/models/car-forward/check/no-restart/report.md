# CarForward

TLC reached 1,168 states, more than the chart budget of 500, so the chart draws only the bug paths: 8 states and 7 arrows.

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

## Rules that hold
TypeOK, LandedToldOnce, NoticeToSender
