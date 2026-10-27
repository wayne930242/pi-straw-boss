# Proposal for pi-intercom: a mailbox flush waits for receipts

Status: a proposal for pi-intercom's owner. Nothing in this repository changes pi-intercom. It closes the one gap the sb backend spec
(`2026-10-26-sb-backend.md`, **Queueing and concurrency** and **Risks**) can only document. Written at B5; the line numbers are those of
pi-intercom 0.18.1 (`broker/broker.ts`).

## The gap

A session that registers with `acknowledgesReceipts: true` (the sb server does, for each tower identity) gets a receipt wait for every
**live** delivery: `completeSocketDelivery` (`:1162`) records the delivery as `unknown`, starts a 5 s timer (`RECEIPT_TIMEOUT_MS`, `:49`),
and tells the sender `delivered` only when the receiver's `message_receipt` arrives (`confirmPendingReceipt`, `:1186`). A receiver that
disconnects first, or stays silent, makes the broker answer the sender `delivery_failed`, `outcomeKnown: false`, `retryable: true`
(`failPendingReceipt`, `:1200`; `settlePendingReceiptsForSocket`, `:1212`), and the sender retries under the same message id.

Mail that waited in the mailbox while the receiver was away gets none of that. `flushMailboxForSession` (`:1288`), called when the session
registers (`:603`), does for each matching entry:

1. `this.mailboxMessages.splice(index, 1)` (`:1325`): the entry leaves the mailbox;
2. `writeMessage(session.socket, …)`: the frame is written to the socket;
3. `this.updateDeliveryRecord(entry.fromKey, entry.message.id, "socket_delivered")` (`:1344`): the sender's record says delivered.

A socket whose process has died still accepts writes, which is why live deliveries wait for a receipt. The flush does not wait. If the
receiver crashes after step 1 and before it has written the message down, the broker has dropped the mail and recorded it as delivered:
nobody is told, and a sender's retry under the same id is answered from the delivery record as already delivered.

For the sb server the window is the time between registering and the queue store's fsync of the first flushed message. The server keeps it
small (it reads the batch first, and writes it to `queue/` before anything else), but it cannot close it.

## The change

For a session with `acknowledgesReceipts`, the flush becomes what a live delivery is: the message leaves the mailbox when the receiver's
receipt proves it arrived.

- **Keep the entry until the receipt.** In `flushMailboxForSession`, for a session that acknowledges receipts, do not `splice`. Mark the
  entry `inFlight: { socket, timer }` and write the frame. Entries that are `inFlight` are skipped by later flushes and by
  `pruneMailboxMessages`' eviction order until they settle, but they still count toward `MAX_MAILBOX_MESSAGES`.
- **Settle on the receipt.** `message_receipt` with a proof status (`RECEIPT_PROOF_STATUSES`, the check at `:906`) for an in-flight entry:
  clear the timer, `splice` the entry, `updateDeliveryRecord(…, "socket_delivered")`, and release the ask edge as `confirmPendingReceipt`
  does. The sender, if still connected, gets `delivered` then.
- **Settle on a loss.** The timer (`RECEIPT_TIMEOUT_MS`) or the receiver's socket closing (`:391`, next to
  `settlePendingReceiptsForSocket`) clears `inFlight` and leaves the entry in the mailbox, with its delivery record still `queued`. The
  next registration of the identity flushes it again.
- **No change for sessions that do not acknowledge receipts**, and none for live deliveries.

The same receiver may then see a message twice (it wrote the receipt but the socket closed before the broker read it). That is the
at-least-once delivery the sb server already handles: `seen.jsonl` keeps the sender id, the base message id, and the SHA-256 of the text,
so a second copy gets its receipt and is not queued again (spec, **Dedupe**).

## Tests the change needs

- Register a receipt-acknowledging session, queue mail for it while it is away, register it, and answer each frame with a receipt: the
  mailbox is empty afterwards and each sender saw `delivered` once.
- The same, but close the socket before the receipt: the mailbox still holds the message, the sender's record is not `socket_delivered`,
  and a second registration receives the message again.
- A silent receiver (no receipt within `RECEIPT_TIMEOUT_MS`): the entry stays, and is flushed again at the next registration.
- A session that does not acknowledge receipts flushes exactly as before.
- The 256 cap counts in-flight entries, and eviction never drops one before it settles.

## What Straw Boss does until it ships

The gap stays a documented limit of B5: the server reads the flushed batch first and writes it before anything else. Straw Boss's own
sends to a tower identity are retried for 30 s (`src/reach.ts`), which does not help here, since the sender was told `delivered`. Once the
change ships, the sb server's integration test for it (`tests/server-tower-queue.test.ts`, the broker behaviors the spec pins) flips from
"a crash after the flush loses the mail" to "the mail comes back at the next registration"; the spec's **Risks** entry is then removed.
