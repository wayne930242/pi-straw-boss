import { m } from "./paraglide/messages.js";
import { get } from "./post.ts";

// The header's notice for a pair request that waits while the Same Wi-Fi tab is not open (docs/specs/2026-10-30-sb-gui-lan.md, Approval, "When nothing is open"; this computer's page only). It reads `lan/pending?peek=1` every five
// seconds, which the server does not count as an open tile, so the sessions' own notice stays; the button opens the tile on that tab, where the number is typed. While the tab is open it has the requests itself, and the notice goes.

export function mountLanWait(button: HTMLButtonElement, open: () => void, every = 5000) {
	let text = "";
	const show = (peer: string) => {
		const next = peer ? m.lan_pending_waiting({ peer }) : "";
		button.hidden = !peer;
		if (next !== text) (text = next, button.replaceChildren(next));
	};
	button.onclick = open;
	const read = async () => {
		if (document.hidden) return;
		const r = await get("lan/pending?peek=1").catch(() => undefined);
		const first = r?.ok && Array.isArray(r.body.pending) ? (r.body.pending[0] as { peer?: unknown } | undefined) : undefined;
		show(first && !document.querySelector(".lan:not([hidden])") ? String(first.peer ?? "") : "");
	};
	void read();
	return setInterval(() => void read(), every);
}
