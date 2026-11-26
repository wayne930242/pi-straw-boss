import { randomBytes } from "node:crypto";
import { restrictLabel } from "../link/text.ts";
import { type WorkerSpec, workerMessage } from "../workerslip.ts";
import { ASK_KEEP_MS, type Asks } from "./asks.ts";

// A controller main's `call_tower` `worker` (docs/specs/2026-11-26-ally-workers.md, Controller side): the code writes the slip's line over the brief and sends it to the teammate's box as the workspace's tower identity, a plain
// `tower` with a fresh ask for the main (no new wire kind). The box's ally run opens the worker on it; every outcome (a refusal, the final report, a crash receipt) is a `tower-reply` to that ask, which reaches the main by its
// session id. A worker's ask lives 7 days, as its route on the box does.

export const WORKER_ASK_KEEP_MS = 7 * ASK_KEEP_MS;
export interface WorkerSendDeps {
	now(): number;
	ws: string;
	identity: string;
	/** A holder request as `identity` (`send`). */
	link(body: Record<string, unknown>): Promise<unknown>;
	asks: Pick<Asks, "open">;
	/** The features the target's fresh caps list. */
	caps(team: string, device: string): string[];
	log(event: string, facts: Record<string, string>): void;
}
type Sent = { ok: boolean; error?: string; details?: { team?: string; device?: string; id?: string; asked?: boolean } };

export async function sendWorker(d: WorkerSendDeps, target: { id: string; short: string; label: string; team: string }, spec: WorkerSpec, brief: string, asker: { id: string; name: string }): Promise<{ text: string; details: Record<string, unknown> }> {
	const label = `${restrictLabel(target.label)} (${target.short})`;
	if (!d.caps(target.team, target.id).includes("tower.worker")) throw new Error(`${label} opens no workers: its build or config lists no tower.worker (a capacity budget and a workers section), or it has not been heard from for 2 hours. Nothing was sent.`);
	const text = workerMessage(spec, brief), ask = randomBytes(16).toString("hex");
	const sent = (await d.link({ op: "send", device: target.id, text, reply: true, awaitsReply: ask }).catch((e: Error) => ({ ok: false, error: e.message }))) as Sent;
	if (!sent.ok) throw new Error(`Not sent to ${label}: ${String(sent.error ?? "no reason").slice(0, 300)}`);
	const x = sent.details ?? {};
	if (x.asked !== true || !x.id || !x.device || !x.team) throw new Error(`Sent to ${label}, but its build took no ask id: no answer can reach you, so do not wait for one`);
	d.asks.open({ ask, envelope: x.id, device: x.device, team: x.team, for: asker.id, forName: asker.name, workspace: d.ws, tower: d.identity, at: d.now(), expires: d.now() + WORKER_ASK_KEEP_MS });
	d.log("worker-sent", { workspace: d.ws, device: target.short, branch: spec.branch });
	return { text: `Worker ${spec.label} (branch ${spec.branch}, ${spec.points} point${spec.points === 1 ? "" : "s"}) went to ${label}. Its answer comes to you as a link_reply: a refusal, or the worker's final report (branch, head, pushed or not). Do not wait in your turn; carry on.`, details: { ...x, worker: spec.branch } };
}
