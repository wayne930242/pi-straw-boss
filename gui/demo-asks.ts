import type { AskView } from "../src/asktypes.ts";
import type { Net, Unit } from "../src/net.ts";

// `?asks` in the demo (docs/specs/2026-11-28-boss-asks.md, The GUI): four open questions to the boss, one of each kind, with the counts the server writes on the plates (askmirror.ts `countOn`).

export function asksFromUrl(net: Net, now: number, search = location.search) {
	if (!new URLSearchParams(search).has("asks")) return;
	const min = 60_000, asks: AskView[] = [
		{ id: "demo-ask-1", n: 3, kind: "boss", subject: "Deploy the billing migration tonight, or wait for QA?", asker: "billing-main", where: "Harbor API › billing", since: now - 7 * min, ws: "w1", unit: "a1", pane: true, item: { session: "a1", id: 2 } },
		{ id: "demo-ask-2", n: 4, kind: "dialog", subject: "When should the ops deploy go out? (+1)", asker: "ops-main", where: "Harbor API › ops", since: now - 3 * min, ws: "w1", unit: "a3", pane: true },
		{ id: "demo-ask-3", n: 5, kind: "wait", subject: "Approve the prod deploy key for checkout", asker: "checkout-main", where: "Lighthouse Web › checkout", since: now - 26 * min, ws: "w2", unit: "b1", wait: "W2", item: { session: "b1", id: 4 } },
		{ id: "demo-ask-4", n: 6, kind: "link", subject: "ci-box asks for the staging database password", asker: "ci-box", where: "ci-box", since: now - 64 * min, ws: "w2", unit: "t2", wait: "W3" },
	];
	net.asks = asks;
	const put = (u: { key: string; subs: Unit[]; asks?: number }) => ((n) => (n && (u.asks = n), u.subs.forEach(put)))(asks.filter((a) => a.unit === u.key).length);
	for (const b of net.bases) [...(b.tower ? [b.tower] : []), ...b.tabs.flatMap((t) => t.units), ...b.outside].forEach(put);
}
