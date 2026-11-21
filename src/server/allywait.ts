import { randomBytes } from "node:crypto";
import { bodyOf, fieldsOf } from "../header.ts";
import { waitOwner, waitWhat } from "../link/kinds.ts";
import { restrictLabel } from "../link/text.ts";
import { readRoutes, type Route } from "./allyroute.ts";
import { ASK_KEEP_MS, type Asks } from "./asks.ts";
import type { LinkWaits } from "./linkwaits.ts";
import type { Slot } from "./record.ts";
import { listServices } from "./towerstore.ts";

// A wait raised by a main an ally run opened (docs/specs/2026-11-21-box-mac-waits.md §14, live-check fix A). Such a main's `call_tower` goes to its device's ally runs and never to a local run (allyroute.ts), and an ally run forwards no wait
// (runtools.ts). So the code forwards the one kind of message a model need not read: a `call_tower` whose header the main's own code wrote with `waits-on=` its opener. It goes to that device as a local run's `tower_send` `waitsOn` would send
// it: the wait field and the raiser's ask, the out wait recorded for the raiser, and the device's states and reply back to the raiser. The main's words go to the device that opened it and to nothing else, so the isolation rule holds.

/** The wait a `call_tower` header raises (`waits-on=`, not a withdrawal), read from fields and never from text. */
export const raisedWait = (text: string): { short: string; owner: string; what: string } | undefined => {
	const f = fieldsOf(text);
	return f?.kind === "call_tower" && f["waits-on"] && f["waits-cancel"] !== "yes" ? { short: f["waits-on"], owner: f["waits-owner"] ?? "", what: f["waits-what"] ?? "" } : undefined;
};

const refusal = (opener: Pick<Route, "label" | "short">, target: string) => `An ally run of ${restrictLabel(opener.label)} (${opener.short}) opened you, so a wait from you goes to that device only, not to ${target}. Say in your report to it what you need from ${target}, or leave the wait to the boss of this computer.`;

/** Why a session may not raise a wait on `target`: an ally run opened it for another device. Undefined for a main nobody opened and for its opener (`device-resolve` with `raise`, linkwaitsops.ts). */
export function raiserRefusal(slot: Slot, from: string, target: { id: string; short: string; label: string }, now: number): string | undefined {
	const opened = listServices(slot).flatMap((s) => readRoutes(slot, s.workspace, now).filter((r) => r.to === from && r.kind === "opened"));
	return !opened.length || opened.some((r) => r.device === target.id) ? undefined : refusal(opened[0]!, `${restrictLabel(target.label)} (${target.short})`);
}

export interface OpenedWaitDeps {
	ws: string;
	now(): number;
	/** The workspace's tower identity, as which the wait goes over Straw Link. */
	identity: string;
	log(event: string, facts: Record<string, string>): void;
	link?: (body: unknown, from: string) => Promise<unknown>;
	asks?: Pick<Asks, "open">;
	waits?: Pick<LinkWaits, "sent" | "newId" | "handleOf">;
	/** A line the code writes to the raiser (`link_wait_state`, about the opener), with the wait's `L<n>` once it has one. */
	tell(to: string, text: string, wait?: string): Promise<unknown>;
}
type Sent = { ok: boolean; error?: string; details?: { team?: string; device?: string; id?: string; asked?: boolean; waited?: boolean } };

/** Forwards the wait an opened main raised on the device that opened it, or refuses one on any other device; either way the main is told, and nothing goes to a run. */
export async function forwardOpenedWait(d: OpenedWaitDeps, route: Route, from: { id: string; name: string }, event: string, text: string): Promise<void> {
	const raised = raisedWait(text)!, opener = `${restrictLabel(route.label)} (${route.short})`;
	const no = async (why: string, line: string): Promise<void> => void (d.log("ally-wait-refused", { workspace: d.ws, from: from.id, why }), await d.tell(from.id, `Your wait was not forwarded: ${line}`).catch(() => undefined));
	if (raised.short !== route.short) return no("not-opener", refusal(route, raised.short).replace(/^A/, "a"));
	if (!d.link || !d.waits) return no("no-router", "this computer's sb server runs no link holder or wait router.");
	const ask = randomBytes(16).toString("hex"), owner = waitOwner(raised.owner), what = waitWhat(raised.what) || "(no summary)";
	const wait = { id: d.waits.newId(), state: "open" as const, owner, what, handle: d.waits.handleOf(from.id) };
	const sent = (await d.link({ op: "send", device: route.device, text: bodyOf(text), reply: true, awaitsReply: ask, wait }, d.identity).catch((e: Error) => ({ ok: false, error: e.message }))) as Sent;
	if (!sent.ok) return no("send-failed", `the message to ${opener} was not sent (${String(sent.error ?? "no reason").slice(0, 300)}).`);
	const x = sent.details ?? {}, asked = x.asked === true && !!x.team && !!x.device && !!x.id;
	if (asked) d.asks?.open({ ask, envelope: x.id!, device: x.device!, team: x.team!, for: from.id, forName: from.name, workspace: d.ws, tower: d.identity, at: d.now(), expires: d.now() + ASK_KEEP_MS });
	const n = d.waits.sent(d.ws, { wait: wait.id, ...(asked ? { ask } : {}), ...(x.id ? { envelope: x.id } : {}), device: route.device, team: x.team ?? route.team, label: route.label, short: route.short, raiser: from, owner, what, event, plain: x.waited !== true });
	d.log("ally-wait-sent", { workspace: d.ws, from: from.id, wait: n });
	const how = x.waited === true ? "it routes it to its owner or its boss and says each step, which you hear here" : "its build takes no wait field, so it went as text that opens with [waits on you: …], which its ally run escalates";
	await d.tell(from.id, `Your wait ${n} (${what}) went to ${opener}: ${how}.${asked ? " Its answer comes to you directly." : ""}`, n).catch(() => undefined);
}
