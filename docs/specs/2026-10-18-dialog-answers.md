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
- `secret_drop` is terminal-only, from every page, this computer's and a paired device's. An earlier draft of 0.28.0 made its masked dialog answerable
  from this computer's page with the value sealed to the asking session's key; that was taken out before release (**Why a secret is terminal only**).
  The server never takes a secret's value from a request and never sends one; the bridge never relays a secret dialog and refuses any answer to one.
- Every answer carries the dialog id and the digest of what the page showed, and an `answerId` minted by the page; one `answerId`
  takes effect at most once.

## Owners

| Owner | Channel | Answerable from the page |
|---|---|---|
| pi-robot-hand ≥ 0.3.0, `robot_hand` | Dialog contract v1, prefix `robot-hand` (`pending`, `answer`, `answer-result`, `closed`; its README and `tests/dialog.test.ts` are the reference, including the digest vectors) | Its selector: one choice. The clipboard choice is `localOnly` and refused from a remote page. |
| @juicesharp/rpiv-ask-user-question 2.13.9, `ask_user_question` | Its own `rpiv:ask-user:*` channel: `prompt {toolCallId, questions}`, `answer {toolCallId, requestId, answers[] \| cancel}`, `answer-result {ok, code, requestId, toolCallId}`, `blocked {active, toolCallId}`; first answer wins, all-or-nothing validation | One to four questions: single or several choices, own words ("Type something."), a note per question. |
| pi-robot-hand, `secret_drop` | Contract v1, prefix `robot-hand:secret`: `pending {id, toolCallId, digest, secret: {label, instructions[], url?, destination}}`, `answer {id, answerId, digest, value}` (on the session's own event bus only), `answer-result`, `closed`; digest `["secret", label, instructions, url\|null, destination]` | **Nothing, from any page.** The owner's contract could take a value, but this extension never sends one: its bridge keeps the dialog to itself, and the page shows a plain `secret_drop` wait read-only (the call's own arguments still show in its comms history, as for any tool call; the value never does). |
| pi-mcp-adapter (fork, later) | Contract v1, prefix `pi-mcp-adapter:dialog` | Inert until that package emits. |
| pi-code hooks extension, hook confirmation ("Allow bash?") | Contract v1, prefix `pi-code:dialog`, choices Allow and Deny, `toolCallId` = the gated call. A *gate*: it binds to an open call of any tool (it must name one), where the other owners bind to their own tool's call. | One choice: Allow or Deny. |
| Any extension's `ctx.ui.select` and `ctx.ui.confirm` (an `mp-infra` command review, for one) | Contract v1, prefix `straw-boss:ui`, published by the wrap of `ctx.ui` in `src/intercept.ts` (**Any extension's select and confirm**). A gate that binds to the one tool call in flight; a *twin*, which yields to a contract owner's dialog on the same call. | A select: one choice, from this computer's page or a paired device. A confirm: Yes or No, **from this computer's page only**. |
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
- **A secret dialog is not relayed.** The bridge keeps it (so its owner's close and cancel still work) but leaves it out of the list: its label, steps, and destination do not leave the session, and no key pair is made or sent. A list too long to relay drops the other dialogs' content as before.
- **Answers it acts on:** `{version: 1, type: "answer", to, id, answerId, digest, choice | answers | sealed}` only when `to` is its `bridgeId`,
  the event comes from G as `gui.json` names it now (a server it followed before is ignored), G is the broker's current owner of the channel, and the event's owner epoch is the current one. It never judges
  an answer's meaning; the adapter hands it to the owner. An answer to a secret dialog, whatever it carries (a plain `value`, a `sealed` one, nothing), is refused as `rejected` (`terminal_only`), the dialog stays open, and the
  owner hears nothing. A resend of an answerId already taken replays its outcome and is never opened again.

## Hub (`src/dialogs.ts`, in the session running the GUI server)

- Registers the channel with `ownerEligible: true` when the server starts (before `gui.json` names this session), publishes `sync`
  (`ownerOnly`), syncs again on an owner epoch change, and drops a session's dialogs on `session_left` and all of them when the server
  stops. A change pushes the snapshot at once.
- **Binding.** A bridge's list counts for a unit only when intercom reports the sender on that bridge's pane, the registry has a live
  unit on that pane, and the unit's session file is the one the list names (canonical paths). Each net reading binds afresh.
- **What the page may answer** (merged into the unit's `pending` as `answer: {dialog, digest, select? | questions?}`; otherwise `why`
  says why the terminal must answer): exactly one open dialog for the session; no answer on its way; not too long; its adapter known;
  a dialog naming a `toolCallId` must be one of the session file's open calls (the newest assistant message may leave several unanswered), with the adapter's tool, or of any tool for a gate; the digest recomputed from the
  relayed content equals the dialog's. A `secret_drop` among the open calls, or a secret dialog from an older bridge (with or without the `key` it once relayed, which is ignored), keeps everything in the terminal ("It waits for a secret."). A unit with an open
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
   A request that carries a `value` at all (a secret) is refused before anything is looked up: 403 `local_only` from a remote request, 400 `terminal_only` from this
   computer's page, and no refusal quotes it. `checkAnswer` and the hub's `send` refuse one too, so nothing of it is read, kept, sealed, or relayed.
5. The hub sends the answer to the bridge (or calls this session's) and waits ≤ 5 s for its ack. A value is never sent (409 `unsent`). The ack: 200 `{outcome, reason?, by?}`, 503
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
composer's blocked reason reads "It waits on a dialog: answer it above, or in its terminal" when the panel can answer.
A `secret_drop` wait is read-only on every page: no field, no Submit, no Show terminal (its mirror stays hidden). This computer's page says "A secret is entered in the terminal only, not here. Answer it in the terminal on the computer the GUI runs on." (zh-TW: 機密內容只能在終端機輸入，這裡不接受。…); a remote page keeps "For security, entering a secret is not supported remotely" (zh-TW: 安全考量，遠端不支援…). Both then name the terminal. The masked field, its Show and Hide, and its CSS are gone from `gui/`. `npm run gui:dev`
demonstrates a robot_hand selector and a questionnaire that answer, and a secret_drop that only waits.

## Any extension's select and confirm (unreleased)

Status: built after 0.28.0. It answers the question "why not intercept `ctx.ui`?" with: do, but only for `select` and `confirm`, and as one more
owner of the contract, so nothing downstream changes. The motivating case is moldplan-center's `mp-infra-hooks.ts`, which calls
`ctx.ui.confirm("mp-infra command review", reason + command)` inside a bash `tool_call` handler: no package publishes that dialog, so the GUI
could only say "It waits on more than one dialog" and could not answer.

**Why this is safe where 0.5.x keys were not.** The page still sends no keys and nothing reads the screen. The wrap is the *owner* of the dialog: it
takes the one answer through the same completion path as the terminal (it dismisses the terminal dialog with `signal` and resolves the extension's own
call with the answer), so the extension sees exactly what a terminal answer would give it.

**The wrap (`src/intercept.ts`).** Every extension's `ctx.ui` is a getter returning the runner's one `uiContext` object (a plain object spread of the UI
plus pi's prompt wrappers), so replacing its `select` and `confirm` reaches all of them without changing any extension. `input`, `editor`, and `custom` are
never touched: a secret may be typed there (SB-F001), and `custom` dialogs are whole screens. For a wrapped call:

1. It decides whether to relay (below). If not, or if starting the relay throws, the call is the original, once, and nothing is left behind (the relay's
   answer registration is withdrawn). A throwing listener on the bus after the dialog opened is ignored.
2. It publishes `straw-boss:ui:pending {version: 1, id, toolCallId, digest, select}`: a select with its options as choices; a confirm as one select whose
   `title` is the title, a blank line, and the message, with the choices **Yes** and **No** and `confirm: true`. The digest is `selectDigest`, which
   includes a `"confirm"` marker for a confirm, so a relay cannot pass a select off as a confirm.
3. It calls pi's own method (the runner's wrapper, so `ui_prompt_start`/`end` and the blocked relay are unchanged) with `signal` = the caller's signal
   combined (`AbortSignal.any`) with its own.
4. An answer (`straw-boss:ui:answer`) is checked against the relay (the id, the digest, one index in range, an `answerId`): a refusal is an
   `answer-result {accepted: false, reason: "digest" | "malformed" | "closed"}` and the dialog stays; an accepted one sets the answer, aborts the terminal
   dialog, and emits `answer-result {accepted: true}` and `closed {by: "remote", answerId}`. The call then resolves with the chosen option, or `true` for Yes
   and `false` for No, whatever the aborted dialog returned. The wrap keeps a listener for the last 16 closed ids so a late answer hears `closed`.
5. If the terminal answers first, it emits `closed` with `by` `local` (Escape in a select: `cancel`; the caller's signal: `abort`; an error: `error`), so the
   page's answer is `stale`.

**What is relayed.** Only when all hold: exactly one tool call is in flight in the session (tracked from `tool_execution_start`/`end`, which pi emits
before `tool_call` handlers run), and it is not `secret_drop`; no other dialog is open through the wrap (**depth**); a select has 1 to 100 string options;
title plus message or options total at most 12,000 characters. Otherwise the dialog is terminal-only and the page keeps saying so. **Depth:** only the
outermost dialog is relayed. The wrap counts `select`, `confirm`, and also `input`, `editor`, and `custom` (pure pass-through there: never relayed, arguments and
results untouched; pi's own `ui_prompt_start` counting leaves `custom` out, the wrap's does not, on purpose). A dialog of any of the five that opens over a
relayed one withdraws it (`closed {by: "error"}`) and is not relayed, because the page could not tell which dialog an answer would dismiss, and a page answer
could abort a stacked `input` or `custom` with it. The count resets when pi swaps its ui object and at `agent_end`, so a dialog that never settles cannot hold
relaying off for good. The hub's own rules still apply on top: one open dialog, the digest, no
answer on its way, the bound call among the session file's open calls, and a `secret_drop` among them keeps everything in the terminal.

**Contract-owned dialogs are not relayed twice.** The adapter is marked `twin`. In the bridge (`report.open`), a twin and a non-twin dialog on the same
`toolCallId` cannot both be open: a twin that arrives while an owner's dialog is open on that call is dropped, and an owner's dialog that arrives while a
twin is open evicts the twin (when it is still `open`; one with an answer on its way is left to settle). So `robot_hand` (whose selector is
announced on the bus before it calls `ctx.ui.select`), pi-code's gate, and `secret_drop` are each relayed only by their owner, with their notes, copy
command, and rules. `ask_user_question` is a `ctx.ui.custom` screen and is only counted. A twin is never relayed for a call whose tool has a contract owner (`robot_hand`, `secret_drop`,
`ask_user_question`), even when the owner's dialog was refused or never came: it stays terminal-only, so a `localOnly` choice or a note cannot be lost to a raw relay.
A twin the page shows says it "was opened while {tool} was running; it may not be about that call", since the wrap only knows which call was in flight.

**Remote policy** (the user's decision, 2026-10-19: "遠端只能答 select，confirm 只能本機"). A paired device may answer a select but not a confirm. The
server decides by the listener the request arrived on (`src/remote.ts`: the verdict's `remote` flag, which becomes the `https:` origin `control.ts`
checks): an answer to a dialog with `select.confirm` from the remote listener is refused with **403 `local_only`** before anything is sent to the bridge.
The page (`gui/ask.ts`, `readOnlyHere`) draws a confirm on a paired device's page read-only: the question as written, "A confirmation can be answered only
in the terminal or on the page of the computer the GUI runs on, not from a paired device. This page shows it read-only." (zh-TW: 確認對話框只能在終端機，
或在執行 GUI 的那台電腦的頁面上回答，已配對的裝置不能回答。這個頁面只能查看。), and the composer does not say "answer it above". This computer's page
answers both.

**Lifetime.** The wrap marks the object it wrapped with a `Symbol.for` key, so several loaded copies of the package (or several entries) wrap it once. Pi
replaces the object in `setUIContext` (bind or mode change), so the marker is checked at `session_start` and at every `tool_execution_start` and the wrap is
put back on the new object. A session without a UI has pi's shared `noOpUIContext`, which is never mutated. At `session_shutdown` open relays close
(`by: "error"`), the answer listener is removed, and the original methods are restored if they are still ours. Subagents run the wrap too (it is installed
beside the bridge, before the subagent return).

**Tests.** `tests/intercept.test.ts` (over a fake pi and over pi's real `ExtensionRunner` with an `mp-infra`-like `tool_call` handler: Allow and Deny,
select by index, terminal first, the caller's signal, answer checks, no relay for zero or two calls, secret_drop, oversize, input/editor/custom untouched, no-UI
object untouched, depth withdrawal, fallback on a throwing bus, a throwing or rejecting original, the swap and shutdown, several copies),
`tests/answer.test.ts` (end to end over the fake broker: a confirm answered from the page Allow and Deny, a select, terminal first, a `robot_hand` selector not
duplicated, two calls, secret_drop), `tests/bridge.test.ts` (the twin rule in both orders and on another call), `tests/control.test.ts` (a confirm from a
paired device is 403 `local_only` and nothing is sent; this computer's page and a remote select are accepted), `tests/panel.test.ts` and `tests/contract.test.ts`
(the page's read-only confirm in both locales; the adapter, the flag, and the digest).

## Failure behavior

| Condition | Behavior |
|---|---|
| pi-intercom missing in the asking session, an owner without a channel, a payload of another version | No dialog: 0.5.x's read-only panel. |
| The GUI session's intercom down, or `gui.json` names no live owner | Bridges keep their dialogs and resend on the `owner`/`connection` event; meanwhile read-only. |
| Two open dialogs, a `toolCallId` that is not one of the file's open calls, a digest mismatch | Read-only with the reason. |
| A dialog over 15 KiB | Read-only: "too long to show here". |
| The owner refuses the answer | `rejected` with the reason; the dialog stays open and answerable. |
| Terminal answered first | `stale`: "It was already answered in the terminal." |
| No verdict within 2 s, no ack within 5 s | `unknown`; Check again replays the same `answerId`; other answers get `busy` until the owner closes it. |
| GUI server stops mid-answer | The page says "Not confirmed"; the dialog stays as it is; the next server resyncs. |
| 8 GUI channels in one process | Read-only for that session, one warning in its terminal. |
| A scratch server with another state directory | Only bridges reading that directory follow it. |
| A wrapped `select`/`confirm` that cannot be relayed (no call or two in flight, `secret_drop`, nested, oversize), or whose relay fails to start | The original call, untouched: terminal-only. |
| A confirm answered from a paired device | 403 `local_only`; the page shows it read-only. |
| `secret_drop` | Read-only on every page: the dialog is not relayed, a crafted answer finds nothing to answer (409), a request with a `value` is refused (400 on this computer's page, 403 remote), and a forged answer sent to the bridge is `rejected` (`terminal_only`). |

## Why a secret is terminal only

A review (SB-F001) showed that pi-intercom identities are self-reported. A process of the same user can register under the asking session's identity, relay an identical
secret dialog carrying its own public key, and receive the value the page seals to it; sealing protects the value on the channel from a bystander, not from whoever the hub
believes is the asking bridge. The pane and file binding does not close it: it checks what intercom says about a sender, and that is the part a same-user process can say too.
The decision (2026-10-19): this release takes secret entry out of the GUI. A secret is entered in the terminal only, and the encryption and the other fixes stay.

**Residual risk that blocked it.** Until pi-intercom can verify who a bridge is (an identity the broker vouches for, or a key the asking session proves it holds out of band),
the hub cannot tell the real bridge from an impostor, so any scheme that hands a secret to "the bridge" is open to one. Re-enabling needs that, then: the bridge relays a key
again, the hub pins and seals to it, the page draws its field behind one gate, and the tests removed here come back from the history (`c9780ae` is the last commit with the full path).

## Secret wire format (not in use: SB-F001)

`src/seal.ts` and `tests/seal.test.ts` keep the envelope below for that day; nothing in the bridge, the hub, or the page calls it.

pi-intercom's broker hands every message on the server's channel to every capable session (every pi bridge in Herdr, subagents included), and any process of the same user may
join that channel, so a plaintext value would reach sessions it was not meant for. A secret therefore never travels in the clear:

- **Dialog** (bridge → hub): the dialog would carry `key`, base64url of the dialog's 32-byte X25519 public key.
- **Answer** (hub → bridge): `{version: 1, type: "answer", to: <bridgeId>, id, answerId, digest, sealed: {v: 1, epk, iv, ct}}`, with no `value`. `epk` is the base64url public key
  of a fresh X25519 pair the server makes for this answer, `iv` 12 random bytes, `ct` the AES-256-GCM ciphertext followed by its 16-byte tag, all base64url.
- **Key:** ECDH(server's ephemeral private, bridge's public) → HKDF-SHA256 with salt `epk ‖ bridgePublic` (raw bytes), info `pi-straw-boss/secret/1`, 32 bytes.
- **Binding:** the GCM's associated data is the JSON `["pi-straw-boss/secret/1", dialogId, digest, answerId, bridgeId]`. The bridge uses its own copy of the dialog id and digest,
  so a ciphertext made for another dialog, digest, answerId, or bridge does not open.
- **Fail closed:** the hub would seal only to a key pinned for that dialog and send nothing without one; the bridge would open only with that dialog's private key and refuse a plain `value`.
- **In process:** when the server runs in the session that asked, the same sealed message would be handed over in-process, so there is one path.

## Threat model

Same-OS-user processes can already type into every terminal and are trusted. The guards stop: model-written text (it cannot reach
extension channels or `pi.events`); a stale or replaced dialog receiving an answer meant for another (dialog id, digest, state
machine, `answerId`); any GUI but the running one answering (the channel's owner is G from `gui.json`, checked with the broker's owner
epoch); an answer for one session reaching another (`to`, the pane and file binding, rechecked at each answer); a remote page acting on
this computer (`localOnly`, the remote write guards). In-process listeners on `pi.events` see dialog ids and answers; that is the
shared bus every owner documents. The one exception to "same-user processes are trusted" is a secret: intercom identities are self-reported, so a same-user process can pose as the asking session's bridge (**Why a secret is terminal only**).
The GUI therefore never takes, seals, or sends a secret, and a secret dialog never leaves its session. A session that can read the plain value on its own `pi.events` is the owner's own process, as in the terminal.

## Tests

`tests/contract.test.ts` (digest vectors shared with pi-robot-hand, payload validation, the robot_hand and rpiv mappings, the
server's answer check), `tests/bridge.test.ts` (fake bus and channel: a channel only when a dialog opens and `gui.json` names another
session, the in-process hand-off, untracked or mismatched `toolCallId`, other versions, every message trigger, answers dropped on a
wrong sender, epoch, or `to`, a server `gui.json` no longer names, every outcome and the replay, closes by tool end and shutdown, the cap, no intercom),
`tests/dialogs.test.ts` (binding, every merge rule, a resend reaching a bridge whose answer is on its way, `secret_drop`, a dialog of no tool call, closed dialogs telling late answers who
closed them, 503 when not the channel's owner, 5 s unknown), `tests/control.test.ts` (the route's guards and body checks, 409, 400,
429, 504, replay, nothing reaches Herdr input), `tests/answer.test.ts` (end to end over the fake broker: answered once through the
owner, terminal first, a silent owner with Check again, busy, and the late close, a subagent under its launcher, nothing outside Herdr), `tests/net.test.ts` (a pi-herdr-agents worker runs only
the bridge), `tests/seal.test.ts` (the envelope: a round trip, another key, a changed ciphertext, IV, or server key, another dialog's binding, malformed input), `tests/secret.test.ts` (the secret_drop wait on both streams, requests with a value refused from a paired device and from this computer's page), `tests/ask.test.ts` (the panel's body builder and outcome texts, `localOnly` hidden remotely), `tests/imports.test.ts`
(budgets).

A secret must not leave a trace, and now must not even be asked for: `tests/answer.test.ts` runs a secret_drop end to end with a third session on the channel, which the fake broker hands every
message, and looks for the value and for what the secret asks for in everything that session was handed, every message the broker was given, and every snapshot, response, console and stream write, notice, and file
under the run (a value POSTed from this computer's page is refused, no answer is ever published, nothing reaches the owner). `tests/bridge.test.ts` covers the bridge's refusals (a plain value, a sealed one, nothing) and that the dialog is not relayed,
`tests/dialogs.test.ts` that no hub path leaves a secret answerable and that `send` refuses a value, and `tests/panel.test.ts` that no field is drawn.

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
