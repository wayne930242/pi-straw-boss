import { randomBytes } from "node:crypto";
import { type StandingKind, waitWhat } from "../link/kinds.ts";
import { restrictLabel } from "../link/text.ts";
import { ASK_KEEP_MS, type Asks } from "./asks.ts";
import type { LinkWaits, Who } from "./linkwaits.ts";

// A question or a notice for a teammate device's standing main (docs/specs/2026-11-21-box-mac-waits.md D13, 0.81.3): a main's `call_tower` `standing` (linkwaitsops.ts `standing-send`) and a tower run's or ally run's `tower_send`
// `standing` (runtools.ts) both send it here. It goes as the workspace's tower identity with the wait field and its `kind`, which a build that lists `tower.standing` hands to its wait router and never to an ally run; there the
// standing main is told in a code-written line and reads the text in `board_read`. A question carries the asker's ask and is recorded as an out wait for it, as a forwarded `waitsOn` is, so the standing main's answer and each step
// come back to the asker; a notice carries no ask and nothing comes back. The code builds every field: no model retypes the device, the asker, or the ask.

export interface StandingDeps {
	now(): number;
	/** The workspace whose ledger records a question, and its tower identity, as which the message goes. */
	ws: string;
	identity: string;
	/** A holder request as `identity` (`send`). */
	link(body: Record<string, unknown>): Promise<unknown>;
	asks: Pick<Asks, "open">;
	waits: Pick<LinkWaits, "sent" | "newId" | "handleOf">;
	log(event: string, facts: Record<string, string>): void;
}
type Sent = { ok: boolean; text?: string; error?: string; details?: { team?: string; device?: string; id?: string; asked?: boolean; waited?: boolean } };

/** Sends one question or notice to `target`'s standing main; a question needs the main that asks, whose answer it is. Throws with the holder's reason when nothing was sent. */
export async function sendStanding(d: StandingDeps, target: { id: string; short: string; label: string }, kind: StandingKind, message: string, what: string, asker?: Who): Promise<{ text: string; details: Record<string, unknown> }> {
	if (kind === "question" && !asker) throw new Error("A question for a teammate's standing main needs a main here to get its answer: name it with for (a main that asked you), or send it as a notice");
	const summary = waitWhat(what) || waitWhat(message.split("\n")[0] ?? "") || "(no summary)", label = `${restrictLabel(target.label)} (${target.short})`;
	const ask = kind === "question" ? randomBytes(16).toString("hex") : undefined;
	const wait = { id: d.waits.newId(), state: "open" as const, owner: "", what: summary, handle: asker ? d.waits.handleOf(asker.id) : "", kind };
	const sent = (await d.link({ op: "send", device: target.id, text: message, reply: kind === "question", ...(ask ? { awaitsReply: ask } : {}), wait }).catch((e: Error) => ({ ok: false, error: e.message }))) as Sent;
	if (!sent.ok) throw new Error(`Not sent to ${label}: ${String(sent.error ?? "no reason").slice(0, 300)}`);
	const x = sent.details ?? {}, routed = x.waited === true, asked = !!ask && x.asked === true && !!x.team && !!x.device && !!x.id;
	d.log("standing-sent", { workspace: d.ws, kind, device: target.short, routed: String(routed) });
	const how = routed ? `went to the standing main of ${label}` : `went to the tower of ${label} as a plain message: its build has no standing route, so its ally run reads it`;
	if (kind === "notice") return { text: `Your notice ${how}. Nothing comes back for it.`, details: { ...x, standing: kind } };
	if (asked) d.asks.open({ ask: ask!, envelope: x.id!, device: x.device!, team: x.team!, for: asker!.id, forName: asker!.name, workspace: d.ws, tower: d.identity, at: d.now(), expires: d.now() + ASK_KEEP_MS });
	const id = d.waits.sent(d.ws, { wait: wait.id, ...(asked ? { ask } : {}), ...(x.id ? { envelope: x.id } : {}), device: x.device ?? target.id, team: x.team ?? "", label: target.label, short: target.short, raiser: asker!, owner: "", what: summary, plain: !routed, kind: "question" });
	return { text: `Your question ${id} ${how}. ${asked ? `Its answer comes to ${asker!.name} directly${routed ? ", and each step is told to it" : ""}.` : "That build takes no ask ids, so the answer reaches an ally run here, not the main."}`, details: { ...x, standing: kind, wait: id } };
}
