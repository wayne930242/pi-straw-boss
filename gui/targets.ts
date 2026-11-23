import { HEAD_KEY } from "../src/headkey.ts";
import type { Net } from "../src/net.ts";

// Where the head's input sends (docs/specs/2026-11-24-zen-f.md §5.2, §6): the rows of the target picker, pure. The head first; then the towers addressed in this visit, newest first; then every other base of this computer in the map's order. A box's
// bases (shown through an operate session) are not targets: `@` resolves this computer's workspaces. Each row is a label and at most one state word: `talking` (the boss's conversation there is live) or `working` (a run works). No count of any kind.

export interface Target { /** The workspace id, or `HEAD_KEY` for the head. */ ws: string; label: string; state?: "talking" | "working" }

export function targetsOf(net: Net | undefined, addressed: readonly string[], head: string): Target[] {
	const bases = (net?.bases ?? []).filter((b) => !b.box), byId = new Map(bases.map((b) => [b.id, b] as const));
	const row = (b: (typeof bases)[number]): Target => {
		const svc = b.tower?.service, state = svc?.conversation && !svc.conversation.closing ? "talking" as const : svc?.run || b.tower?.mark === "working" ? "working" as const : undefined;
		return { ws: b.id, label: b.label, ...(state ? { state } : {}) };
	};
	const seen = new Set<string>(), out: Target[] = [{ ws: HEAD_KEY, label: head }];
	for (const ws of [...addressed].reverse()) if (!seen.has(ws)) (seen.add(ws), out.push(byId.get(ws) ? row(byId.get(ws)!) : { ws, label: ws }));
	for (const b of bases) if (!seen.has(b.id)) (seen.add(b.id), out.push(row(b)));
	return out;
}

/** Whether the target picker is offered: the head's `to` needs headless runs, which the head unit says (`service.headless`); without them the server refuses `to`, and no button is drawn. */
export const pickable = (net: Net | undefined) => Boolean(net?.head?.service?.headless);
