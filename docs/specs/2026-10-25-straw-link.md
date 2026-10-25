# Straw Link: towers talking across computers

Status: design, not built. Decisions were made by the user on 2026-10-25; this revision answers the review of the same day (**Review
record** at the end).

Straw Link lets the tower of a workspace on one computer exchange messages with the tower of the same project on a teammate's computer,
and shows the teammate's bases in the GUI. It also lets you add an unattended computer that runs pi in auto mode as a workstation of
yours, and dispatch work to it. Messages go through a relay that only carries ciphertext. Teams are small (2 to 10 computers) and bound
to one project each.

## Decisions

| Question | Decision |
|---|---|
| What a remote message may do | It may start a turn of the receiving tower. Anything beyond the reads and replies of **Remote turns** needs this computer's confirmation, unless this computer's own policy trusts the sender more. |
| Unattended computers | A computer with nobody at it joins as an unattended device and takes work from the devices its own policy names as controllers, at `dispatch` by default (**Unattended devices**). Its security (sandbox, credentials, network, the policy file) is its infra's job. |
| Where it lives | The client is a module of pi-straw-boss (`src/link/`). The relay is a separate open-source Go repository. |
| Teammates on one tailnet, others not | Identity comes from keys, never from the network. Every message goes through the relay in phase 1, tailnet teammates included. Phase 2 adds a direct tailnet path with the relay as fallback. |
| Keys | One shared team key encrypts; each computer's own key signs. |
| Who adds and removes computers | Any attended member invites a new computer. Only an admin removes a computer, changes a role, or rotates the key. The founder is the first admin. |
| How a computer joins | A trusted member shows a QR code; the new computer scans it. A tailnet teammate may instead join with one approval; an unattended computer joins from a file its infra writes. |
| What a controller sees of an unattended device | Each unit's state, its running monitors, and its last report; no chat or terminal in phase 1. |
| Where the relay runs | moldplan-center's public cloud, as its own Nomad job on its own subdomain. |
| Offline messages | Kept 7 days on the relay, within per-team caps. |

## Non-goals

- Privacy between members of one team. Every member holds the team key, so any member's computer can read every message of the team.
  The relay delivers a message only to the computers it is addressed to, and receivers drop what is not addressed to them, but that is
  routing, not secrecy.
- Hiding traffic metadata from the relay: it sees team ids, device ids, roster entries' public keys and roles, sizes, and times.
- Sharing chat logs or terminals across computers. Dialogs cross only as **Remote turns** (`forward`) and **Unattended devices** say.
- A remote MCP server. A tool call to a server in the cloud would hand it the plaintext. Claude Code and Codex sessions keep reaching the
  net through their sidecar; a local stdio MCP adapter can come later.

## Terms

- **Device**: one computer's Straw Link identity: an Ed25519 signing key and an X25519 encryption key, with a label. Its id is the first
  16 bytes of `sha256(signing public key)` in lowercase RFC 4648 base32 without padding (26 characters, the last one's two spare bits
  zero, so each id has one spelling); its **short id** is the first 6. Its **key record** is the canonical
  encoding of `(id, signing public key, encryption public key)`. A device is **attended** (someone works at it) or **unattended** (pi runs
  there in auto mode with nobody at it); the roster records which.
- **Label**: a device's display name, 1 to 40 ASCII letters, digits, spaces, `.`, `_`, `-`, with no space at either end, unique within a
  team.
- **Team**: a set of devices bound to one project, with a random 16-byte id and a 32-byte team key per epoch.
- **Roster**: the team's append-only log of membership entries, each signed by a member with the authority for it. Every device keeps a
  copy and checks every entry.
- **Epoch**: the team key's version. A removal or a rotation starts a new one.
- **Controller**: a device an unattended device's policy names, with the trust level it gets there.
- **Link holder**: the one pi session per computer that holds the device keys and the relay connection (**Link holder**).
- **Ally base**: a teammate's workspace on the project, as the GUI shows it.

## Architecture

```
computer A                                                            computer B
tower ── tower_send({workspace, device}) ──┐                 ┌── tower of the bound workspace
                                            │ straw-boss/link │     (held until idle, then a remote turn)
link holder: sign, encrypt ── HTTPS POST ──► relay ── SSE ──► link holder: verify, decrypt, deliver
GUI: ally bases ◄── presence (ephemeral) ────┘                └──► GUI: ally bases
```

### Addressing and delivery

- `tower_send` gains a `device` parameter: a device id, a short id, or a label unique in the team. With `device`, `workspace` names a
  workspace label on that device, or is omitted for the device's bound workspace. Ambiguity is an error that lists the candidates.
  `tower_send` without `device` stays local, as today. pi-intercom's `name@machine` form is not used.
- The tower's call goes to the link holder over pi-intercom's extension channel `straw-boss/link`; the link holder signs, encrypts, and
  posts it. A session that is not the tower of a bound workspace cannot send over the link.
- A delivery goes **only to a tower**: a tower whose pane's cwd is inside the team's `project`; with several, the one whose cwd is
  closest to the project root, then the first in Herdr's workspace order. Mains and members never receive link deliveries, so only towers
  need the gate of **Remote turns**. A tower takes a delivery on `straw-boss/link` only from the session `holder.json` names.
- A team's `project` may not be the home folder or contain `~/.pi`; the GUI and the policy check refuse it.
- With no such tower, the message waits in the local inbox (`link/inbox/`, 7 days) with a GUI notice. The first tower that opens on the
  project gets it, after its sender's membership and trust are checked again at that moment. An attended device never opens a tab or a
  session for a remote message; an unattended device opens one for a controller (**Unattended devices**).
- `tower_list` adds the ally towers with `remote: true`, the device id and label, and the state from the last presence.

### Link holder

The link holder is elected on its own, not through the GUI server's election (the GUI's `stopped` record and its UI-only adoption do not
fit a headless unattended device):

- Its record is `link/holder.json` (session id, pi-straw-boss version, PID, start time) under `link/holder.lock`. Candidates are joined pi
  sessions in Herdr, towers first; a session on a newer pi-straw-boss takes over; when the holder's session ends, the next candidate
  takes over within a few seconds.
- Only the holder reads the device keys, holds the relay stream, writes the team files, and runs the tailnet join listener. Every write
  to a team file (roster, sequence numbers) happens under the lock, so two holders during a takeover never deliver one message twice.
- A takeover resumes the stream from the team file's last event id. A new stream always carries every queued envelope this device has
  not acknowledged, whatever its event id, so a saved event id never skips mail; the receive checks drop repeats.
- The holder acknowledges an envelope to the relay only after it is delivered to a tower or written to the inbox, so a crash or a
  takeover delivers it again rather than losing it; the receive checks drop the second copy.
- The holder needs a joined pi session to run in. An unattended device's infra starts one pi session at boot, in the first bound project
  (**Unattended devices**). The election works when one long-lived tower is the only candidate, as in straw-boss-desk, whose shell
  starts `herdr server` and one tower pi and keeps them alive.

## Storage and policy

All Straw Link state lives in `<pi agent dir>/straw-boss/link/` (`~/.pi/agent` unless `PI_CODING_AGENT_DIR` names another; mode 700,
files mode 600 where the OS has modes), never in `config.json`. Paths may hold non-ASCII characters (a Windows profile such as
`C:\Users\測試PM`), so the code handles them as Unicode paths and never builds a shell command from them:

```
link/device.json          signing and encryption key pairs, label, next sequence number
link/device.id            this device's id, written at first start, for an infra to read
link/teams/<team>.json    roster copy, team keys by epoch, relay URL, last event id, last sequence number per sender
link/inbox/               messages waiting for a tower
link/holder.json, .lock   the link holder's record and lock
link/join.txt             an invite an infra wrote (unattended devices only)
```

On an attended device, `config.json` holds what the user chooses:

```json
{
  "link": {
    "relay": "https://relay.example",
    "teams": { "<team id>": { "project": "~/projects/moldplan-center", "share": "status" } },
    "trust": { "<device id>": "forward" }
  }
}
```

`project` is the directory a workspace's cwd must be inside to take the team's messages. `share` is `presence` (the device is online) or
`status` (also each bound workspace's tower and tab states and labels; the default). `trust` raises named senders above `reply`.

An unattended device reads its policy from `/etc/straw-link/policy.json`, a fixed path with no override, and the link holder refuses
unattended mode unless that file and its directory are owned by another user and not writable by its own user. That protects the policy
from the link: no message or roster entry changes it. It does not protect it from what a `dispatch` turn runs, which can change the
device user's own files, pi-straw-boss included; keeping a controller's work from that is the infra's job (a sandbox, a separate user):

```json
{
  "unattended": true,
  "trust": { "<controller device id>": "dispatch" },
  "teams": { "<team id>": { "project": "/srv/work/moldplan-center", "share": "status" } }
}
```

A controller listed as `true` instead of a level is at `dispatch`. `config.json`'s `link` section is ignored on an unattended device.

## Cryptography

Node's built-in `crypto` only, so pi-straw-boss keeps no runtime dependency (verified on Node 24 with OpenSSL 3.5: Ed25519, X25519, HKDF,
ChaCha20-Poly1305 with AAD). Bun is not supported for Straw Link until its `chacha20-poly1305` is checked.

**Encoding.** Every signed or authenticated structure is a canonical byte string: fields in a fixed order, each as a 4-byte big-endian
length followed by its bytes; a list is one such field whose bytes are a 4-byte count followed by its encoded items; integers are 8-byte
big-endian and at most 2^53. A decoder rejects truncated fields, trailing bytes, and lengths past the end. JSON is only the wire
wrapper, never what is signed. Signatures and AADs are checked over the bytes received, never over a re-encoding of decoded fields.
`tests/link/vectors.json` in this repository fixes every byte layout below, with invalid cases and their reasons; the relay replays it.

**Domain separation.** Every signature and MAC covers `context ‖ team id ‖ canonical fields`, with these contexts:

| Context | Signs |
|---|---|
| `straw-link/envelope/1` | An envelope |
| `straw-link/roster/1` | A roster entry |
| `straw-link/request/1` | A relay request |
| `straw-link/join/1` | A join request: HMAC-SHA256(invite secret, context ‖ team ‖ canonical(B's key record, label)) |
| `straw-link/labels/1` | AAD (with team and epoch) of labels and label tables under a team key |

| Use | Primitive |
|---|---|
| Sign | Ed25519 (`crypto.sign(null, …)`) |
| Encrypt an envelope | ChaCha20-Poly1305 with the epoch's team key, a random 96-bit nonce, and the envelope's canonical header as AAD |
| Seal a key to one device | A fresh X25519 key; HKDF-SHA256 of the shared secret with info `straw-link/seal/1 ‖ team ‖ epoch ‖ ephemeral public key ‖ recipient public key`; ChaCha20-Poly1305 with that one-use key, a zero nonce, and empty AAD |
| Encrypt a join request | ChaCha20-Poly1305 with HKDF-SHA256(invite secret, info `straw-link/join-key/1 ‖ team`), empty AAD |
| HKDF | SHA-256 with an empty salt everywhere |
| Safety words | `sha256("straw-link/safety/1" ‖ team ‖ sha256(inviter key record) ‖ joiner key record ‖ invite secret)`, first 44 bits as 4 words of the BIP-39 English list |

A random 96-bit nonce stays safe far beyond any team's traffic within one epoch; no rotation by message count.

## Envelope

```
header = v=1, team, epoch, roster head (seq, hash), from (device id), seq (per sender, +1 each queued envelope; 0 for ephemeral),
         id (random 16 bytes), ts (ms), kind, to (list of device ids; empty means the whole team), ephemeral (bool, fixed by the kind:
         a receiver drops an envelope whose flag disagrees with its kind)
envelope = header, nonce, ct = ChaCha20-Poly1305(team key[epoch], plaintext, aad = canonical(header)),
           sig = Ed25519(from, "straw-link/envelope/1" ‖ team ‖ canonical(header) ‖ nonce ‖ ct)
```

A receiver drops an envelope, and records why in the link log, unless every check passes:

1. `from` is a member of the **current** roster, not removed, and `kind` is one it may send (**Message kinds**).
2. `epoch` is the current epoch, or the one before it when the envelope's `roster head` is older than the entry that started the
   current epoch (the sender wrote it before it knew of the rotation) and the sender is still a member.
3. `to` names this device, or is empty and `kind` allows the whole team.
4. A queued kind's `seq` is greater than the last one taken from `from` (kept per sender in the team file; a device whose team file is
   lost must join again, so the guard fails closed). An ephemeral kind has its own check: its `ts` is newer than the last one taken from
   `from` for that kind, and an older one is ignored without effect on queued messages. A sender saves its next `seq` before it sends,
   so a crash never reuses one.
5. `roster head` is not ahead of this device's copy; if it is, the receiver fetches the roster first, and a relay that cannot show that
   head raises the roster-mismatch notice. A head not ahead must match this device's entry hash at that seq, else roster-mismatch.

The header checks (version, team, kind, ephemeral flag) run first, then the signature, then 1 to 6, so a forged envelope never moves a
`seq` or `ts` guard.
6. `ts` is no more than 10 minutes in the future and no older than 7 days.

The relay keeps envelopes from one sender in arrival order and does not reorder by `seq`, so a sender posts its queued envelopes one at
a time, in `seq` order, and retries an envelope until it lands before it posts the next.

## Message kinds

Plaintexts are canonical structures too; every text field is cut to its limit and never parsed as a header. Limits the table leaves
open: 64 KB for a dialog and its answer, 256 bytes for ids, labels, and states. Only `presence` may go to the whole team; a
`dialog-answer` comes only from an attended device.

| Kind | Sender → receiver | Plaintext | Notes |
|---|---|---|---|
| `tower` | Any member → named devices | fromWorkspace, toWorkspace (optional), reply expected, text (at most 192 KB) | Delivered to a tower as **Remote turns** says. |
| `presence` | Any member → whole team | label, roster head, workspaces with tower and tab states and labels (with `share: status`) | Ephemeral: the relay keeps only the last per device and never queues it. |
| `confirm-request` | Receiver of a remote turn at `forward` → the sender's device | dialog id, digest, tool, full arguments (at most 12 000 characters), requesting tower | Shown as an alert in the sender's GUI. |
| `confirm-answer` | That device → the requester | dialog id, digest, allow or deny, answer id | Taken only from the device the request went to, only with a matching id and digest, once. |
| `dialog-open` | Unattended device → its controllers | dialog id, digest, owner, the dialog as the GUI hub shows it (select, confirm, `ask_user_question`) | Never a `secret_drop`. |
| `dialog-answer` | A controller at `dispatch` → that device | dialog id, digest, answer, answer id | First valid answer wins, as with the local GUI. |
| `dialog-close` | Unattended device → its controllers | dialog id, by whom | Closes the alert in every controller's GUI. |
| `unit-status` | Unattended device → its controllers | each unit's state, its running monitors, its last report (at most 4 KB) | Ephemeral, like presence. |
| `notice` | Unattended device → its controllers | kind (failure, waiting more than 30 minutes), unit, text (at most 1 KB) | Raises a notice in the controller's GUI. |

Read acknowledgements go to the relay as relay requests, not as envelopes.

## Roster

An entry is the canonical structure `(seq, prev = sha256(previous entry), op, subject, by, epoch, payload)` with its signature, where
`subject` is a device's key record, its role (`admin` or `member`), and `attended`. The first epoch is 1; `create` has `prev` of 32 zero
bytes; an entry's hash covers its full encoding including the signature.

| Op | Signed by | Payload |
|---|---|---|
| `create` (seq 0) | The founder (admin, attended) | The label table under the first team key |
| `add` | Any attended member | The new device's label under the team key; the team key sealed to the new device |
| `remove` | An admin | Epoch + 1; the new key sealed to each remaining device; the full label table under the new key |
| `role` | An admin | The subject's new role |
| `rotate` | An admin | Epoch + 1, as `remove` without a removal |

Rules every client and the relay enforce:

- The signer is a member of the roster at `prev` with the authority above; an unattended device signs nothing but its own presence and
  messages.
- A `remove` or `role` that would leave no attended admin is invalid.
- A removed device id is banned: no later `add` may name it. A device comes back only with new keys.
- An `add` gives the role `member`; an unattended device never becomes admin. A `role` or `remove` carries the subject's current key
  record and `attended`. A `remove` or `rotate` seals the new key to exactly the remaining members.
- The relay appends an entry only when `prev` is the head and the entry is valid by these rules, and answers a conflict with the head.
  Every rule that makes an entry invalid is one the relay can check from plaintext (keys, roles, `attended`, signers, bans), so a client
  that still meets an invalid entry has met a dishonest relay: it stops using the team and raises a roster-fork notice; it never skips
  the entry. The same holds when a device's own sealed key in a `remove` or `rotate` will not open, or a label table will not decrypt:
  the relay cannot check either, so the device treats it as a fork.
- Labels are encrypted, so a duplicate label is a valid entry. The inviter's client refuses to post an `add` whose label equals a current
  member's; every client shows short ids beside duplicate labels and refuses such a label as a `device` target.
- If the only attended admin's computer is lost, nobody can remove it and the team has to be created again. The GUI asks the founder to
  make a second attended admin once the team has two attended devices.
- A late joiner reads every label from the most recent label table plus the `add` entries after it.

## Joining with a QR code

```
A (attended member)                      relay                               B (new computer)
GUI: Invite to <team>
  s = 32 random bytes
  POST /v1/invites {team, h: sha256(s), expires}  (signed by A)
  QR: strawlink1:<base64url(canonical(relay URL, team, s, A's id, sha256(A's key record), pinned device id or empty))>
                                                                   GUI: Join a team → scan with the camera, or paste
                                                                   B makes its device keys if it has none
                       ◄── POST /v1/invites/<h>/join {B's key record, label,
                             mac}, encrypted under HKDF(s)
A (over its stream) decrypts, checks the mac, the label, the id ban
A's GUI: B's label and short id, three sets of 4 words → A taps the set B's screen shows
                                                                   (B computes its words from the QR's key-record hash, before its add)
A posts `add` for B
                                                                   B fetches the roster: its `add` must be signed by A's id from the QR,
                                                                   A's key record must hash to the QR's value; then B checks every entry
                                                                   back to `create` and opens the team key
Other members see a valid `add` signed by A → accept B
```

- `s` never reaches the relay, which only holds `sha256(s)`: it can neither read the join request nor answer the invite. B pins the team
  to A's key record from the QR, so a relay cannot enroll B into a team of its own.
- The words are always compared. In person, A looks at B's screen; not in person, B reads them on a call. A wrong tap refuses the join and
  ends the invite. An invite works once and lapses after 10 minutes; a second join request to it is refused.
- B then picks the local directory that is the project (the GUI offers the open workspaces' folders and a folder picker) and its `share`.
- The scan runs in B's GUI page on `http://127.0.0.1` (a secure context, so the browser may open the camera) with the browser's
  `BarcodeDetector` where present; elsewhere B pastes the text. No QR decoder is bundled in phase 1. Paste is a first-class path, not a
  fallback: Electron hosts such as straw-boss-desk have `BarcodeDetector` on macOS but not on Windows, and the host handles the camera
  permission itself.
- Creating a team (`/boss link create <project>` or the GUI) needs a team token from the relay's operator (**Relay**), and makes the
  `create` entry and the first team key.

## Joining an unattended device

1. The link holder writes `link/device.id` at its first start. The infra reads it.
2. In A's GUI, "Invite an unattended device" takes that id. The invite carries it, lasts up to 24 hours, and accepts only that device.
3. The infra writes the invite text to `link/join.txt` (mode 600), for example from an Ansible vault.
4. At start the link holder reads it and sends the join request. A's GUI shows the request marked unattended with its label and short id,
   and A approves; the pinned id stands in for the safety words, so a leaked `join.txt` is useless to any other device.
5. The link holder deletes `join.txt` once the join succeeds or is refused, and logs the outcome.

## Joining over the tailnet

When A and B share a tailnet, A may open "Accept tailnet joins" for one team in the GUI. For 10 minutes, a `tailscale serve` entry on port
8444 (tailnet only, never Funnel; the port is a parameter of the code `remote.ts` shares) points at a loopback listener of A's link
holder that takes only join requests. B picks A's machine from `tailscale status --json` and sends its key record and label there. A's
GUI shows the `Tailscale-User-Login` that serve attached (verified by Tailscale, not by B) with B's label and short id, and A approves with
one click; no words, since Tailscale vouches for the connection. A's reply carries the team id, the relay URL, and A's key record, and A
posts B's `add`; B then checks the roster as above. Tagged nodes have no user login, so they cannot join this way and use the QR code or
`join.txt`. The listener and its serve entry close after one join or the 10 minutes. The tailnet ACL has to let B reach A's port 8444; the
GUI says so when B's request times out.

## Remote turns

### What makes a turn remote

The tower's link code receives deliveries on `straw-boss/link`, never through pi-intercom's message path. It marks runs by what enters
them, not by how they started, because one run can span several `agent_end`s (a retry, a compaction, queued messages continue it without
a new `before_agent_start`), and pi may still steer a custom message into a run that started meanwhile:

- A delivery waits while the tower is busy. The next one goes out from a fresh tick that checks `isIdle()` in that same tick, as
  `pi.sendMessage({ customType: "straw-link", … }, { triggerTurn: true })`.
- From the moment a `message_start` or `message_end` with `customType: "straw-link"` is seen, however it got into the run, the run is a
  **remote turn** at that sender's level, and stays one until `agent_settled`. Two remote messages in one run leave it at the lower of
  their levels; anything else that joins (a local steer, an intercom message) leaves it as it is.
- A delivery that waits more than 10 minutes for an idle tower raises a GUI notice.

### Trust levels

The sender's level comes from the receiving device's policy (`config.json`'s `link.trust` when attended, the policy file when unattended);
a sender with no entry is at `reply`. Trust names device ids only, never a team, and lapses when the sender leaves the roster. No message,
roster entry, or remote setting raises a level.

| Level | A remote turn from this sender |
|---|---|
| `reply` | The allowlist below runs; anything else opens the gate's confirm on this computer. |
| `forward` | The allowlist below runs; anything else sends a `confirm-request` to the sender's device and waits for its `confirm-answer`. |
| `dispatch` | Runs as a turn of a local message would. The device's own guards (hooks, sandbox, the infra around it) still apply. |

At `reply` and `forward` the tower's `tool_call` hook allows, by exact tool name, only:

- `read` of a file git tracks in the bound `project` (resolved with realpath, checked against `git ls-files`) and outside the deny list;
- `grep`, `find`, `ls` with every path argument resolved inside the bound `project`; their output passes through the `tool_result` hook,
  which keeps only the lines and entries that belong to a tracked path not on the deny list (a line it cannot attribute to a path is
  dropped) and replaces `structuredContent` along with `content`, since these tools also walk hidden files git does not ignore;
- `tower_list`, `boss_status`, `todo`;
- `tower_send` with `device` equal to the sender of this turn.

The deny list is refused outright, never confirmed: `~/.pi/`, `~/.ssh/`, `~/.aws/`, `~/.config/`, `~/.gnupg/`, the `link/` directory,
and files named `.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`. Every other tool or path opens the gate.

### The gate

The gate publishes its own dialog through the dialog contract (`owners.ts`), keyed by the call's `toolCallId`, so it reaches the GUI even
when other calls of a parallel batch are in flight (the `ctx.ui.confirm` relay gives up then). The dialog shows the sender's label and
short id, the tool, and its full arguments up to 12 000 characters; a call whose arguments are longer is refused. It is answerable from
this computer's page and from paired devices, like any relayed select. Deny blocks the call with the reason "the boss declined a remote
request"; no answer within 10 minutes blocks it too. The terminal shows the same confirm, and the first answer, there or from a page,
closes the other, as for any contract owner. At `forward` the dialog goes to the sender's GUI as well, through `confirm-request` and
`confirm-answer`. On an unattended device, where nobody answers locally, a gate dialog at `reply` goes to its controllers as
`dialog-open`.

### After the turn

- A message the tower sends during a remote turn to a local session (after a confirm) carries `origin=remote:<sender id>` in its header.
- A reply the tower sends during a remote turn to that turn's sender expects no reply unless the tower asks for one, so two towers do
  not answer each other forever.
- The remote text stays in the tower's context for later turns, which run at full rights. In those turns the `context` event wraps each
  `straw-link` message in a marker naming its device and saying it is a peer's request, not the boss's instruction. This lowers the risk
  without removing it; it is a documented limit, not a guard.

### Header

The header written for the receiving tower adds the verified sender:

```
[straw net from=<name> id=link:<device id> role=tower workspace=<label> remote=<device label> device=<short id> team=<team name>
 verified=yes kind=tower_send scope=tower to=… reply=…]
```

`from`, `workspace`, and `remote` are sender-controlled, so the link code restricts them to the label character set and 40 characters
before `header.ts` quotes them. `id=` is `link:` plus the sender's device id, never a session id (the signed plaintext carries none, and a
local-looking id would let a remote name aim a reply at a local session). `device=` is the short id from the roster. `team=` is this
computer's own name for the team, the folder name of its `project` (or the name in `config.json`): it is not sender text, so it keeps its
characters (a folder named in Chinese stays so) and is only cleaned of control characters, quoted, and cut to 80 characters.

## Unattended devices

An unattended device keeps pi running in the **default** Herdr server, started headless by its infra (launchd or systemd, with a clean
environment), so pi-intercom resolves its sessions' Herdr locations; a named `herdr --session` is invisible to the net today. The infra
runs `herdr server` (not `herdr`, which wants a terminal) under `env -i` with only `HOME`, `PATH`, `TERM`, and `LANG`, and installs Herdr's
pi integration (`herdr integration install pi`), which lets Herdr resume pi panes from their session files. On first boot it creates the
workspace (`herdr workspace create --cwd <first bound project>`) and starts pi in it (`herdr pane run <pane> pi`), so the device has a link
holder before any work arrives; after that, Herdr's restore brings the layout and pi back.

Checked on 2026-10-25 with Herdr 0.9.5 and pi 1.4.0, in an isolated `HOME` with no client ever attached: the server gives a headless
pane a 120×40 terminal, pi starts in it and joins the net; after `herdr server stop` and a new `herdr server`, Herdr restored the layout
and restarted pi with its session within a second, and pi joined the net again. Herdr's documentation says restored agent panes resume
after a client attaches; in 0.9.5 the headless server did not wait for one. Not checked: a real OS reboot, which depends on how the infra
starts the server at boot (a launchd daemon with `UserName`, or a systemd user unit with lingering enabled).

- **Taking work.** A `tower` message from a controller at `dispatch` goes to the tower of the bound workspace. With none open, the link
  holder opens a workspace in the bound `project` directory (which may be outside the home folder: it comes from the policy file, not from
  the GUI's folder picker) and starts its tower there; this is new code, since today a tower opens only in its caller's workspace. It
  opens nothing for any other sender, and nothing outside the bound directories.
- **Asking back.** A dialog that waits on someone in any session on the device (`select`, `confirm`, `ask_user_question`) goes to its
  controllers at `dispatch` as `dialog-open`; the first valid `dialog-answer` is taken, as the local GUI takes an answer, and `dialog-close` closes it in
  every controller's GUI. `secret_drop` stays terminal-only, as everywhere, so on an unattended device it waits until it times out.
- **What a controller sees.** Its GUI shows the device's bases like an ally's, plus `unit-status`: each unit's state, its running
  monitors, and its last report.
- **Reports.** The tower sends results to the controller that dispatched the work with `tower_send`. A failed turn, or a dialog unanswered
  for more than 30 minutes, sends a `notice`.

## Relay

A single Go binary with SQLite (`modernc.org/sqlite`, no cgo) and a Dockerfile, so anyone can run their own. It never decrypts anything:
it checks Ed25519 signatures with the standard library, checks roster entries, and routes.

| Endpoint | What it does |
|---|---|
| `POST /v1/teams` | Create a team from its `create` entry and a one-time team token from the operator (`straw-relay token create`). |
| `GET /v1/teams/{team}/roster?after=seq`, `POST …/roster` | Read entries; append a valid one by compare and set on `prev`. |
| `POST /v1/teams/{team}/envelopes` | Store an envelope for its `to` devices, or for the whole team. |
| `GET /v1/teams/{team}/events` | Server-sent events for this device: envelopes, roster entries, join requests for its invites, the last presence of each member; resumed with `Last-Event-ID`. |
| `POST /v1/teams/{team}/acks` | Mark envelopes read by this device. |
| `POST /v1/invites`, `POST /v1/invites/{h}/join` | Hold an invite hash until it expires; take one join request and pass it to the inviter's stream. |

- Every request but a join carries `X-Straw-Device`, `X-Straw-Time`, and `X-Straw-Sig`: Ed25519 over `straw-link/request/1 ‖ team ‖
  canonical(method, path with query, time, sha256(body))`. The relay accepts it only from a current, non-removed member within 5 minutes of its
  clock. The path is the request target the relay receives, so a relay URL is an origin with no path, and an ingress in front of it
  must not rewrite paths.
- Envelopes are kept 7 days or until every addressee has acknowledged them; ephemeral ones keep only the last per device and kind and are
  never queued.
- Caps per team: 50 MB stored, 256 KB per envelope, 600 envelopes a minute. Per invite: one join request. Over the storage or rate cap
  the relay answers 429 and the client retries later and tells the tower; a single envelope over 256 KB is 413, refused for good.
- An SSE stream sends a comment every 25 seconds to keep proxies from closing it.
- Logs hold team ids, device ids, sizes, and status codes, never bodies.

Deployment: its own Nomad job and subdomain on moldplan-center's public cloud, TLS at the cloud's existing ingress, settled at deploy
time with the moldplan-center infra workflow.

## GUI

- An ally base for each teammate's workspace on a bound project, beside the local bases, with the device label, short id, and the state
  its presence reports. Its units cannot be opened, except for an unattended device whose controller this is (**Unattended devices**).
- Team settings: create a team (with its relay URL, defaulting to `link.relay` in `config.json`, so teammates outside moldplan-center use
  their own relay), invite (QR code, its text), invite an unattended device (by id), join (camera or paste, then the project
  folder), accept tailnet joins, the roster with each device's role, attended or not, and last presence, and for an admin, remove,
  change role, and rotate.
- Notices: a join request waiting, a roster mismatch or fork, a gate or forwarded confirm waiting (an alert, like any confirm), a dialog of
  an unattended device waiting (an alert), the relay unreachable for more than 2 minutes, a message waiting in the inbox for a tower.

### Link actions an agent asks for

An agent may ask for any link action through one tool, `link_request`, with an action (`create`, `invite`, `invite-unattended`, `join`,
`trust`, `leave`, and for an admin `remove`, `role`, `rotate`), its arguments, and a one-line reason. The tool never performs the action
itself: it opens a link dialog through the dialog contract that shows the action, every argument (team, relay URL, project folder,
device label and short id, trust level), the reason, and which session asked. The action runs only when the user approves it, in the
GUI, from a paired device, or in the terminal; deny or no answer within 10 minutes refuses it, and the tool returns the outcome (for an
approved `invite`, the invite text, so the agent can pass it on).

- Approval is per request: no setting, trust level, or earlier approval lets an agent's link action run unasked. A `join` still needs
  the safety-word comparison; approving the request only opens the join screen with the pasted text filled in.
- A remote turn cannot call `link_request` at any level, `dispatch` included; it is outside the allowlist and the gate refuses it
  without a confirm. A request from a remote turn's text reaches the user only as text the local agent may repeat in its own turn.
- On an unattended device `link_request` is refused: its teams and trust come from its infra's policy file and `join.txt` only.
- The link holder carries out the approved action; the requesting session never touches the keys or the team files.

## Presence

The link holder posts one ephemeral `presence` every 30 seconds while online. An ally base whose last presence is older than 90 seconds
shows as offline. A device that sees a teammate on a different roster head for more than 2 minutes raises the roster-mismatch notice.

## Threat model

| Who | Can | Cannot |
|---|---|---|
| The relay, or whoever runs it | See ids, keys, roles, sizes, times; withhold, delay, or drop messages and entries, including keeping some devices from a `remove` (a partition it can hide) | Read a message, a presence, a label, or a team key; add a device or forge an entry; redirect a message to a device it was not addressed to; enroll a new device into a team of its own |
| Someone who saw an unused invite | Send a join request within its lifetime | Join: the words on the real joiner's screen, or the pinned id, decide |
| A member's computer | Read every message of the team; send as itself; invite if attended | Send as another device; remove, change roles, or rotate unless admin |
| A removed device | Keep what it already read | Have a message accepted after the rotation's 10-minute grace; read later epochs; come back with the same keys |
| A teammate's model, writing a remote message | Ask this tower anything; start a turn that reads the bound project and replies | Read outside the project or the deny list, write, run commands, dispatch, or reach local sessions without a confirm, unless this computer's policy trusts that device more |
| A controller of an unattended device, or whoever takes over the controller's computer | Run anything the unattended device's user and guards allow, including changing that user's own files | Change the policy through the link; have the link open work outside the bound directories. Whether the work it runs can reach the policy, other files, or the network is up to the device's infra |
| A local process on a member's computer | Anything the user can; Straw Link treats it as the user | (out of scope) |

## Phase 2: tailnet direct

A device on a tailnet adds its MagicDNS name to its presence. Between two devices that both list one, the link holder first posts the same
envelope to the peer's serve entry, falling back to the relay after 3 seconds or on any error; the receiver runs every check of
**Envelope**, except that a sliding window of seen ids replaces the strictly increasing `seq`, since the two paths can reorder. Offline peers still get their messages from the relay. Phase 2 starts only when phase 1 is in use.

## Build order

1. Canonical encoding, device keys, envelope, sealing, the roster and its rules, with fixed test vectors (no network).
2. The relay with its tests, and a local run of two clients against it.
3. The link holder election and its files; `straw-boss/link`; `tower_send` with `device`, `tower_list`; tower-only delivery and the inbox;
   the header fields.
4. Remote turns: holding deliveries, the run classification, the allowlist and deny list, the gate's dialog, `forward`.
5. GUI: team settings, QR invite and join, ally bases, notices; `link_request` and its approval dialog.
6. Unattended devices (the default-Herdr behaviour is checked, **Unattended devices**): the policy file check, `device.id` and `join.txt`, opening a tower for
   a controller, dialogs and `unit-status` for controllers.
7. Joining over the tailnet.
8. Relay deployment on moldplan-center's public cloud; a two-computer trial on the moldplan-center project; then one with an unattended
   device.

## Review record

Review of 2026-10-25 (fresh-context reviewer, the first draft of this file):

- P0 R-F001 (secret exfiltration at `reply`): path-limited allowlist and deny list in **Remote turns**.
- P1 R-F002 (remote text steered into other turns): deliveries held until idle and run classification.
- P1 R-F003 (mains and members skip the gate): tower-only delivery.
- P1 R-F004 (first line of arguments, spoofable labels): full arguments, short ids, unique labels.
- P1 R-F005 (invite observer joins): words always compared by tapping among decoys; pinned id for unattended joins.
- P1 R-F006 (removed device on its old epoch): current epoch with a 10-minute grace, current roster membership.
- P1 R-F007 (redirected envelopes): receivers check `to`.
- P1 R-F008 (relay enrolls a joiner into a fake team): the joiner pins the inviter's key record from the QR.
- P1 R-F009 (frozen roster, no admin left): the relay checks entries, clients stop on an invalid one, the last attended admin stays.
- P1 R-F010 (named Herdr session invisible): the default Herdr server, headless.
- P1 R-F011 (controller can edit the policy): a policy file the device's user cannot write; the threat model restated.
- P1 R-F012 (confirms in parallel batches stay in the terminal): the gate's own dialog keyed by `toolCallId`.
- P1 R-F013 (only one message kind): **Message kinds**.
- P1 R-F014 (presence fills the cap): ephemeral kinds.
- P1 R-F015 (encoding and domain separation): **Cryptography**.
- P2 R-F016 to R-F030 and the P3 notes are folded into the sections above. Two remain open: the default-Herdr assumption (checked
  before step 6) and Bun support (out of scope).

Re-check of the same day (second revision):

- R-F001 (partly): `read` limited to git-tracked files; `grep`, `find`, `ls` output filtered through `tool_result`; home and `~/.pi`
  refused as a project.
- R-F009 (partly): duplicate labels are valid entries, refused by the inviter's client; every invalidating rule is relay-checkable.
- N1 (remote turns lose their level on retries, or are steered into local runs): runs marked by the `straw-link` message entering them,
  until `agent_settled`; deliveries sent from a fresh idle tick.
- N2 (queued messages dropped after an ephemeral one or a rotation): separate checks for ephemeral kinds; the previous epoch accepted by
  roster head instead of a time grace.
- R-F011 (now P2): fixed policy path, threat model restated.
- P2: gate dialogs on unattended devices go to controllers; the link channel takes only the holder; the holder needs a boot session;
  delivery by pane cwd and workspace order; acks after delivery; `context` markers for remote text; losing the only admin; saved
  `seq`. P3: replies expect none; a notice for long-held deliveries; local processes out of scope. The stale comment at `owners.ts:10`
  (paired devices answer confirms) is fixed when step 4 is built.

Re-check two (third revision): R-F001, N1, N2 resolved; R-F009 resolved with one gap (sealed keys or label tables that will not open),
now treated as a fork. No new P0 or P1. Folded in: the `tool_result` filter keeps only attributable tracked paths and replaces
`structuredContent`; the ephemeral flag is fixed by the kind. For the build: the gate registers in `OWNERS` as a gate, not a twin, and
the link code always sends `straw-link` messages with `triggerTurn`.

## Build record: step 3 (link holder, 2026-10-26)

Built in `src/link/{store,election,holder,routing,config,runtime,wire,text}.ts`; `docs/how-it-works.md` describes the behavior. Where the spec left a choice, the code took this one:

- **`id=` of a remote header** is `link:` plus the sender's device id, not a session id. The signed `tower` plaintext carries no session id, and a local-looking id would let a remote name aim a reply at a local session. `from`, `workspace`, and `remote` are cut to the label character set and 40 characters; `device=` is the short id from the roster; `team=` is the folder name of this computer's own `project`, never text a sender wrote, so it keeps its characters and is only cleaned, quoted, and cut to 80 (R-F029).
- **The inbox is the staging area for every delivery**, not only for towerless ones: a checked message is written to `inbox/` first, then the stream acknowledges it, then the holder offers it to a tower, which removes it once it is in its session. This is how "ack only after delivery to a tower or an inbox write" holds without a tower round trip inside the stream handler. The sender's high-water mark moves in the same locked write as the inbox file (R-F021); a crash before it gets the envelope again and delivers it once, a crash after it and before the ack gets it again and the guard drops the copy.
- **A team file is never created by a write.** `createTeam` (join or create) makes it; `writeTeam` on a missing file throws, and reading a missing or incomplete one is a `TeamFileError`, so a lost file stops the team (R-F021, "a device whose team file is lost must join again").
- **Ephemeral guards stay in memory**: the newest presence `ts` per sender is not persisted (a restart accepts the next presence), since presence changes no queued state.
- **The outbox is not persisted.** A message queued while the relay is down is retried by the holder that queued it; if that holder ends first (it waits 2 s for the queue), the message is lost, and `tower_send` has already answered "queued". Persisting it is a possible later change; the spec only requires the saved sequence number.
- **A tower is chosen by the pane's cwd** (`pane list` gives each pane its cwd; a Herdr workspace has none): the tower pane whose cwd is nearest the project root, then workspace order; `symlink`s are resolved before comparing; a sub workspace has no tower.
- **Candidates wait one look before taking a vacant record** (a tower at once, any other session at its second look), so a tower that starts a moment later is still preferred; a newer pi-straw-boss, or a tower against a non-tower on the same build, takes a live holder's record at once, and a non-tower never takes it from a tower.
- **Requests between towers and the holder** travel in base64 chunks on `straw-boss/link` (the broker refuses an extension payload over 16 KiB); a request over 40 chunks is refused when built. A deliver is only an offer naming an inbox id.

## Build record: step 4 (remote turns, 2026-10-26)

Built in `src/link/{turn,allow,gate,policy,hooks}.ts` (`hooks.ts` registers the pi hooks and runs against a real pi agent session without Herdr; `runtime.ts` wires it to the holder), the confirm kinds in `holder.ts`, and the gate registered in `owners.ts`; `docs/how-it-works.md` describes the behavior. Where the spec left a choice, the code took this one:

- **A run with several remote senders asks one device at `forward`**: the first sender at the run's lowest level. Its answer decides; the others are not asked.
- **`tower_send` back to the sender** accepts the sender's device id, short id, or label as `device`. The holder resolves a label across every team of the tower, so a label that is also another team's device is still ambiguity the holder reports; the allowlist only decides whether the call passes the hook.
- **The deny list applies to any tool's path arguments** (`path`, `file_path`, `filePath`, `file`, `directory`, `dir`, `cwd`, `paths`, `files`), not only to the allowlisted tools, since a refused outright path is never worth a confirm; the argument check is by name, so a tool that hides a path in a command string (bash) reaches the gate, where the boss reads the full arguments.
- **R-F023** is read as hiding: a later local turn sees a marker naming the device and no text of a peer's request that did not start the current run (the spec's wording is "wraps"; hiding is the stricter reading and `hideOldRemote` in `turn.ts` is the one place to change).
- **R-F027**: the stale comment in `owners.ts` is fixed; a paired device answers a `confirm` as this computer's page does.
- **The unattended policy check** (`policy.ts`) is built and used for trust only; refusing to run the holder, `dialog-open` to controllers, and opening a tower for a controller are step 6.
- **The sender's side of `forward`** has the holder API (`confirmRequests`, `answerConfirm`) and a notice; the alert in the GUI is step 5.
- **A policy file that exists but cannot be read** (not `ENOENT`) refuses unattended mode instead of leaving the device attended.
- **Run classification is tested against a real pi agent session** (`tests/link-session.test.ts`, a faux model): a delivery into an idle tower, a message steered into a local run, a follow-up that continues the run, and an automatic retry. pi 1.3.0 fires `tool_execution_start` before `tool_call`, a custom message's `message_start`/`message_end` when it enters the run (steered or not), and one `agent_settled` after the last `agent_end` of a run.
