# CarForward

TLC reached 5,938 states, more than the chart budget of 500, so the chart draws only the bug paths: 20 states and 19 arrows.

## NoCarLeftInTheDark breaks
The shortest path has 5 steps:
0. No slip yet
1. the coordinator sends the car's slip to the tower: Slip waits at the tower; coordinator waits for an answer
2. the tower forwards the slip to the integrator: Slip with the integrator; coordinator waits for an answer
3. the integrator returns the car: Returned by the integrator, notice going out; coordinator waits for an answer
4. the notice is not delivered at the first send: Returned by the integrator, notice not delivered yet; coordinator waits for an answer
5. the sb server restarts: The server holds nothing of the car; the integrator is done with it; coordinator waits for an answer

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

## Rules that hold
TypeOK, NoticeToSender
