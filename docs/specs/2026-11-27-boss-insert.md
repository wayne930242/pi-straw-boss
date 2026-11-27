# Work added while a plan runs

Boss, 2026-11-27: 「插單優先，衝突才停」「同專案就收，別專案交塔台」「寫入規則＋插單當下提醒」.

`prompts/planning.md` §5 tells coordinator and standing mains when to switch tasks and where to route the request. Its wording also goes on the first successful `todo` create result during existing work after a boss input. This is a reminder, not a classifier: the hook does not read the boss's words or change a todo.

A create allocates the last id before `nextId`, or the last N ids for a batch of N. Only an older `in_progress` todo counts; train steps do not. The graph reminder has its own latch and can appear on the same result. Session start arms both; interactive and RPC input re-arm only the insert reminder. Extension input does not.
