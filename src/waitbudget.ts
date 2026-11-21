import type { BossWait, MemorySummary, WaitCardView } from "./net.ts";

// The wait cards in the net snapshot (docs/specs/2026-11-07-wait-cards.md, The snapshot): every page and paired device gets the whole snapshot on every change, so the cards are bounded. Whole cards go newest first across all towers while
// their text sum is at most CARD_TEXTS UTF-16 units; any card after that goes as `{ id, text, at, answered?, cut: true }`, and the page reads its entry with the memory route's `read` when it draws or opens it. Pure: no node module.

export const CARD_TEXTS = 24_000;

/** The UTF-16 units of a card's text fields (what the page draws), and of the press's reason. */
export function cardTexts(card: WaitCardView, reason = ""): number {
	const f = card.from;
	return card.happened.length + card.do.length + (card.url?.length ?? 0) + (card.command?.length ?? 0) + (card.after?.length ?? 0)
		+ (card.options ?? []).reduce((n, o) => n + o.label.length + o.then.length, 0) + (card.secret?.name.length ?? 0) + (f ? f.name.length + (f.workspace?.length ?? 0) + (f.tab?.length ?? 0) : 0) + reason.length;
}

/**
 * The summaries with the cards over the budget cut. Newest first by the wait's `at`; a card that does not fit is cut, and so is every one after it (an older card never takes the room a newer one was refused). The input is not changed.
 */
export function cutCards(sums: MemorySummary[]): MemorySummary[] {
	const rows = sums.flatMap((s, i) => s.bossWaits.flatMap((w, j) => (w.card ? [{ i, j, w, size: cardTexts(w.card, w.press?.reason), at: Date.parse(w.at) || 0 }] : [])));
	rows.sort((a, b) => b.at - a.at || a.i - b.i || a.j - b.j);
	const cut = new Set<BossWait>();
	let used = 0, over = false;
	for (const r of rows) {
		if (!over && used + r.size <= CARD_TEXTS) used += r.size;
		else (over = true, cut.add(r.w));
	}
	if (!cut.size) return sums;
	return sums.map((s) => (s.bossWaits.some((w) => cut.has(w)) ? { ...s, bossWaits: s.bossWaits.map((w): BossWait => (cut.has(w) ? { id: w.id, text: w.text, at: w.at, ...(w.answered ? { answered: w.answered } : {}), ...(w.parked ? { parked: true as const } : {}), ...(w.listed ? { listed: true as const } : {}), ...(w.state ? { state: w.state, ...(w.outcome ? { outcome: w.outcome } : {}), ...(w.ended ? { ended: w.ended } : {}), ...(w.returned ? { returned: w.returned } : {}) } : {}), cut: true } : w)) } : s));
}
