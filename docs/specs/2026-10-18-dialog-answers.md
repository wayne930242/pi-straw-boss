# Answering pi dialogs from the straw net GUI (0.6.0)

Status: built in 0.6.0. It replaces the 0.5.x rule "nothing answers from the browser" for the dialogs whose owners speak a dialog
channel, and it is the Phase 4 bridge of [the GUI-control spec](2026-10-17-gui-control.md#phase-4-optional-in-session-bridge) for
dialogs (drafts and streaming are still not built).

## Why this shape

0.5.0 built an answer path that typed keys after reading the terminal, and each review found a new way for model-written text to make
the screen check accept a dialog in a state the keys did not expect (see the GUI-control spec, "Why answering was deferred"). So the
browser never sends keys here. The package that opened the dialog (its **owner**) publishes it on pi's event bus and takes one answer
for it through its own completion path, exactly as if the user had answered in the terminal; the owner decides whether the answer is
valid. Straw Boss only relays, and refuses whatever it cannot tie to the right session and the right dialog.

- No key reaches a terminal from this feature. The keys endpoint stays Escape-only; nothing reads the screen.
- `secret_drop` stays terminal-only: it never becomes a dialog here, and a session whose open call is `secret_drop` is never
  answerable whatever a bridge reports.
- Every answer carries the dialog id and the digest of what the page showed, and an `answerId` minted by the page; one `answerId`
  takes effect at most once.

## Owners

| Owner | Channel | Answerable from the page |
|---|---|---|
| pi-robot-hand ≥ 0.3.0, `robot_hand` | Dialog contract v1, prefix `robot-hand` (`pending`, `answer`, `answer-result`, `closed`; its README and `tests/dialog.test.ts` are the reference, including the digest vectors) | Its selector: one choice. The clipboard choice is `localOnly` and refused from a remote page. |
| @juicesharp/rpiv-ask-user-question 2.13.9, `ask_user_question` | Its own `rpiv:ask-user:*` channel: `prompt {toolCallId, questions}`, `answer {toolCallId, requestId, answers[] \| cancel}`, `answer-result {ok, code, requestId, toolCallId}`, `blocked {active, toolCallId}`; first answer wins, all-or-nothing validation | One to four questions: single or several choices, own words ("Type something."), a note per question. |
| pi-mcp-adapter (fork, later) | Contract v1, prefix `pi-mcp-adapter:dialog` | Inert until that package emits. |
| pi-ask-user (`ask_user`) and anything else | none | Read-only, as in 0.5.x. |

Each owner has one adapter in `src/owners.ts`; nothing else knows an owner, so swapping the question package means replacing its
entry in `OWNERS`. The contract adapter accepts only `version: 1` payloads: a relay never guesses at another version, so such a dialog
stays terminal-only. rpiv has no dialog id or digest, so its adapter mints the id (a UUID per `toolCallId`) and computes the digest
from the prompt's questions; it closes the dialog on `blocked {active: false}` or the end of the tool call. rpiv ignores the tool's
abort signal, so when that call is aborted the bridge sends it `{cancel: true}`. rpiv's codes map to outcomes: `not_found` → `stale`,
`invalid_payload` → `malformed`, `invalid_answer` and `unsupported_host` → `not-allowed` (all `rejected`, dialog stays open).

Digest: `sha256(JSON.stringify(["pi-dialog/1", ...parts]))` in hex, with `["select", title, labels]` for a select and
`["questions", [[question, header|null, multiple, [[title, description|null]…]]…]]` for a questionnaire. Notes, `localOnly`, `copy`,
and previews are hints and not hashed.

## Bridge (`src/bridge.ts`, every pi session in Herdr, subagents included)

Started by `createStrawBoss` before the `PI_SUBAGENT_ID` return and only when `HERDR_PANE_ID` is set.

- **Accept** a dialog only when its adapter recognises the payload and, if it names a `toolCallId`, that call is in flight with the
  adapter's tool (tracked from `tool_execution_start`/`end`).
- **States** per dialog: `open` → `settling` (an answer is with the owner) → back to `open` if the owner refuses it, or `closed` by the
  owner's close, the end of its tool call (`by: "remote"` when the answer was taken, else `"error"`), or the session's end. A verdict
  that does not come within 2 s leaves it `unknown`; later answers with another `answerId` get `busy` until it closes. The same
  `answerId` sent again waits for, or replays, the outcome it had. A closed dialog is kept 2 minutes (at most 16): a later answer gets
  `stale` with who closed it, the answer that won gets `accepted` again.
- **Where it sends.** `gui.json` (the state directory's, as the GUI uses) gains `ownerSession`, the intercom session id G of the
  session that runs the server. While a dialog is open the bridge rereads it on an mtime change, checked every 2 s. When G is this
  session, the hub is called in-process. Otherwise the bridge registers pi-intercom's extension channel `straw-boss/gui/<first 32 hex
  of sha256(G)>` with `ownerEligible: false` (at most 8 per process, then one warning and read-only), and publishes to the owner only
  while the broker's owner of that channel is G.
- **Messages to the hub:** `{version: 1, type: "dialogs", bridgeId, pane, file, dialogs, closed}` (the full list on every change, on
  `owner` and `connection` events, on a `sync`, and empty at shutdown; a list over 15 KiB drops the dialogs' content and they show
  "too long to show here") and `{version: 1, type: "ack", bridgeId, id, answerId, outcome, reason?, by?}`. `bridgeId` is a random UUID
  per bridge process.
- **Answers it acts on:** `{version: 1, type: "answer", to, id, answerId, digest, choice | answers}` only when `to` is its `bridgeId`,
  the event comes from G as `gui.json` names it now (a server it followed before is ignored), G is the broker's current owner of the channel, and the event's owner epoch is the current one. It never judges
  an answer's meaning; the adapter hands it to the owner.

## Hub (`src/dialogs.ts`, in the session running the GUI server)

- Registers the channel with `ownerEligible: true` when the server starts (before `gui.json` names this session), publishes `sync`
  (`ownerOnly`), syncs again on an owner epoch change, and drops a session's dialogs on `session_left` and all of them when the server
  stops. A change pushes the snapshot at once.
- **Binding.** A bridge's list counts for a unit only when intercom reports the sender on that bridge's pane, the registry has a live
  unit on that pane, and the unit's session file is the one the list names (canonical paths). Each net reading binds afresh.
- **What the page may answer** (merged into the unit's `pending` as `answer: {dialog, digest, select? | questions?}`; otherwise `why`
  says why the terminal must answer): exactly one open dialog for the session; no answer on its way; not too long; its adapter known;
  a dialog naming a `toolCallId` must be the session file's one open call, with the adapter's tool; the digest recomputed from the
  relayed content equals the dialog's. A session whose file's open call is `secret_drop` is never answerable. A unit with an open
  dialog shows as waiting even before Herdr reports `blocked`.

## Answer route (`src/control.ts`)

`POST /<token>/api/sessions/<key>/answer {dialog, digest, answerId, choice | answers}`:

1. The write guards every POST has (Origin, `Sec-Fetch-Site`, JSON, CSRF, 64 KB body, and remotely the Tailscale identity and the
   paired cookie), the registry lookup, and Herdr's check that the pane still runs pi on that session's file.
2. `dialog` ≤ 64 characters, `digest` 64 hex, `answerId` 16–64 of `[A-Za-z0-9_-]` (400 otherwise). A known `answerId` for this
   session returns its stored outcome (10 minutes, 256 entries).
3. The net is read afresh; the unit's dialog must still be this dialog with this digest, answerable or with an answer on its way (so
   Check again reaches the bridge, which replays that answer's outcome, and another answer hears `busy`). If not, a dialog that closed
   a moment ago answers with how it ended (`stale` with `by`, or `accepted` for the answer that won), else 409 `changed`.
4. The body must fit what may be answered (`checkAnswer`): one choice in range for a select, never a `localOnly` one from a remote
   page; for questions, one entry per question with distinct option indexes in range (one at most unless it takes several), own words
   (≤ 8 KB) or a note (≤ 2 KB) without control characters but tab and newline, an option or own words for each, both only when it
   takes several; at most 12 KB together. 400 `bad_answer` with the reason otherwise. One write per session in flight (429).
5. The hub sends the answer to the bridge (or calls this session's) and waits ≤ 5 s for its ack: 200 `{outcome, reason?, by?}`, 503
   `unsent` when the session cannot be reached (nothing was sent), 504 `unknown` without an ack. Answers are never logged.

## Page (`gui/ask.ts`)

The panel sits in the alert dialog and above the composer in the session view (the UI of `wip/ask-user-screen-check` c83c32b, none of
its screen reading or keys). A select shows its title as written (pre-wrapped), one row per choice with its note and the terminal's
number (also when a `localOnly` choice is hidden on a remote page), **Copy command** (the browser's clipboard; it answers nothing), and
**Send answer**. A questionnaire shows each question with its header tag, its options (radio or checkbox), "Or type your own answer", and
"Note (optional)". Send is enabled once every question has an answer. Outcomes: `accepted` "Answered."; `stale` "It was already answered
in the terminal." (or that it closed); `rejected` the reason, still answerable; `busy` "Another answer is on its way; check the terminal";
`unknown` or a network error "Not confirmed. Check the terminal" with **Check again**, which resends the same body and `answerId`. A long
panel scrolls within the comms view and brings its outcome into view. Read-only panels keep 0.5.x's text and **Focus terminal**; the
composer's blocked reason reads "It waits on a dialog: answer it above, or in its terminal" when the panel can answer. `npm run gui:dev`
demonstrates a robot_hand selector and a questionnaire that answer.

## Failure behavior

| Condition | Behavior |
|---|---|
| pi-intercom missing in the asking session, an owner without a channel, a payload of another version | No dialog: 0.5.x's read-only panel. |
| The GUI session's intercom down, or `gui.json` names no live owner | Bridges keep their dialogs and resend on the `owner`/`connection` event; meanwhile read-only. |
| Two open dialogs, a `toolCallId` that is not the file's open call, a digest mismatch | Read-only with the reason. |
| A dialog over 15 KiB | Read-only: "too long to show here". |
| The owner refuses the answer | `rejected` with the reason; the dialog stays open and answerable. |
| Terminal answered first | `stale`: "It was already answered in the terminal." |
| No verdict within 2 s, no ack within 5 s | `unknown`; Check again replays the same `answerId`; other answers get `busy` until the owner closes it. |
| GUI server stops mid-answer | The page says "Not confirmed"; the dialog stays as it is; the next server resyncs. |
| 8 GUI channels in one process | Read-only for that session, one warning in its terminal. |
| A scratch server with another state directory | Only bridges reading that directory follow it. |
| `secret_drop` | Never a dialog, never answerable, 409 for a crafted answer. |

## Threat model

Same-OS-user processes can already type into every terminal and are trusted. The guards stop: model-written text (it cannot reach
extension channels or `pi.events`); a stale or replaced dialog receiving an answer meant for another (dialog id, digest, state
machine, `answerId`); any GUI but the running one answering (the channel's owner is G from `gui.json`, checked with the broker's owner
epoch); an answer for one session reaching another (`to`, the pane and file binding, rechecked at each answer); a remote page acting on
this computer (`localOnly`, the remote write guards). In-process listeners on `pi.events` see dialog ids and answers; that is the
shared bus every owner documents.

## Tests

`tests/contract.test.ts` (digest vectors shared with pi-robot-hand, payload validation, the robot_hand and rpiv mappings, the
server's answer check), `tests/bridge.test.ts` (fake bus and channel: a channel only when a dialog opens and `gui.json` names another
session, the in-process hand-off, untracked or mismatched `toolCallId`, other versions, every message trigger, answers dropped on a
wrong sender, epoch, or `to`, a server `gui.json` no longer names, every outcome and the replay, closes by tool end and shutdown, the cap, no intercom),
`tests/dialogs.test.ts` (binding, every merge rule, a resend reaching a bridge whose answer is on its way, `secret_drop`, a dialog of no tool call, closed dialogs telling late answers who
closed them, 503 when not the channel's owner, 5 s unknown), `tests/control.test.ts` (the route's guards and body checks, 409, 400,
429, 504, replay, nothing reaches Herdr input), `tests/answer.test.ts` (end to end over the fake broker: answered once through the
owner, terminal first, a silent owner with Check again, busy, and the late close, a subagent under its launcher, nothing outside Herdr), `tests/net.test.ts` (a pi-herdr-agents worker runs only
the bridge), `tests/ask.test.ts` (the panel's body builder and outcome texts, `localOnly` hidden remotely), `tests/imports.test.ts`
(budgets).

## Live check (2026-10-18)

Two pis in a scratch Herdr workspace (`--no-extensions`, pi-intercom, the Herdr state extension, pi-robot-hand 0.3.0 at 3e21a04,
rpiv-ask-user-question 2.13.9, this checkout with its own state directory), A running the server, B asking:

- robot_hand in B answered from the page with "Run it in a new Herdr pane" and "No, thanks": the terminal dialog closed, one tool
  result each with `answeredFrom: "browser"`. The same in A (in-process). Copy command copied the command and left the dialog open.
- Terminal first, in B and in A, with the page holding the old snapshot: the page said "It was already answered in the terminal." and the
  tool result carried the terminal's choice once. The same for an rpiv questionnaire.
- rpiv in B: three questions (single with a note, several choices with own words, own words) answered in one Send; the tool result
  matched the page exactly. Two questions again at 390 px.
- secret_drop in B: the panel showed only Focus terminal; a crafted answer got 409.
- Probes: wrong digest 409, an old dialog id 409, no CSRF 403, the same `answerId` twice the same outcome with one effect, another
  answer after it `stale` by `remote`.
- `/boss gui stop` while B waited, then `/boss gui`: answerable again after the resync.
- Remote over the tailnet on a phone-sized page: the clipboard choice hidden and a crafted clipboard answer refused (400), a robot_hand
  and an rpiv answer accepted; `tailscale serve status --json` after `remote off` equalled the recording.
