import type { ConfirmView } from "../src/link/holder.ts";
import { HEAD_KEY } from "../src/headkey.ts";
import type { MemoryProposal, Net, RunDialog } from "../src/net.ts";
import type { Alert } from "./alerts.ts";
import { remoteDialog } from "./linkdialogmodel.ts";
import { alertLine, dialogState } from "./linkmodel.ts";
import { labelOf, type PairRequest } from "./pairs.ts";

// The questions Zen shows as cards beyond a unit's dialog (docs/specs/2026-11-01-zen-view.md, Link cards), read from what the server holds: the snapshot's Link confirms and notices and its towers' memory proposals, and the pending list of pair requests. Nothing
// here is kept: a request the server stopped listing (answered at the computer, timed out) is gone from the next reading, and the item goes with it. Standard does not use these (alerts.ts `alertsOf` is its set).

/**
 * What waits on the boss apart from a unit's own dialog, a trust question and a tower's wait: a confirm a teammate's tower asked (`confirm`), a dialog an unattended device forwarded (`dialog`, whose question is the alert's `pending`),
 * a pair request, and a memory proposal of a tower run. Standard has them in the Link button, the Wi-Fi notice and the tower's notices; Zen draws each as a card.
 */
export type BossCard =
	| { kind: "confirm"; confirm: ConfirmView }
	| { kind: "dialog"; device: string; dialogId: string; digest: string; line: string }
	| { kind: "pair"; request: PairRequest }
	| { kind: "proposal"; ws: string; tower: string; proposal: MemoryProposal; rev: number }
	/** A dialog a headless run waits on (docs/specs/2026-11-24-zen-f.md §2): this computer's page alone hears of it (the server's `run-dialogs` event). */
	| { kind: "run"; dialog: RunDialog };
export interface CardSources {
	/** The pair requests `lan/pending` lists; none on a paired device's page (the server refuses it Wi-Fi access: `local_only`). */
	pairs?: PairRequest[];
	/** When the list was read (the ages are as of then); the snapshot's time when it is not given. */
	pairsAt?: number;
}
/** What a card's answer is bound to besides its key: a confirm's request and a forwarded dialog's question. A change in it is a new question, so the card is made again (Standard's rows are redrawn the same way). */
export const cardSig = (a: Alert): string => (a.card?.kind === "confirm" ? `${a.card.confirm.digest}\u001f${a.card.confirm.args}` : a.card?.kind === "dialog" ? a.card.digest : a.card?.kind === "run" ? a.card.dialog.key : "");
const card = (key: string, name: string, at: number, extra: Partial<Alert>): Alert => ({ key, ws: "", name, role: "none", mark: "waiting", at, ...extra });

export function cardAlerts(net: Net, at: number, { pairs = [], pairsAt = at }: CardSources): Alert[] {
	const out: Alert[] = [];
	for (const c of net.link?.confirms ?? []) out.push(card(`link-confirm\u001f${c.dialogId}`, c.fromLabel, at, { note: c.tool, since: c.at, card: { kind: "confirm", confirm: c } }));
	for (const a of net.link?.alerts ?? []) {
		// Only a forwarded dialog that still asks and that a panel can draw; the other notices (a join request's words are checked in Standard) stay in the Link button.
		if (a.kind !== "dialog" || dialogState(a) !== "open") continue;
		const pending = remoteDialog(a);
		if (pending) out.push(card(`link-dialog\u001f${a.id}`, String(a.data.label), at, { pending, card: { kind: "dialog", device: String(a.data.device), dialogId: String(a.data.dialogId), digest: String(a.data.digest), line: alertLine(a) } }));
	}
	for (const p of pairs) out.push(card(`pair\u001f${p.id}`, labelOf(p), at, { ...(p.ageMs !== undefined ? { since: pairsAt - p.ageMs } : {}), card: { kind: "pair", request: p } }));
	for (const b of net.bases) {
		const tower = b.tower, memory = tower?.service?.memory;
		for (const p of memory?.proposals ?? []) out.push({ key: `proposal\u001f${b.id}\u001f${p.id}`, unit: tower!.key, ws: b.id, name: tower!.name, role: "tower", mark: "waiting", at, closed: !tower!.control, card: { kind: "proposal", ws: b.id, tower: tower!.key, proposal: p, rev: memory!.rev } });
	}
	return out;
}

/**
 * A question a box forwarded that waits and is not the card on the screen says why, once, to `say` (the page's console): in the 2026-11-05 trial such a card stayed off a Zen page with nothing to show for it. `why` is the model's reason
 * for an item (zenmodel.ts), none while it is the card.
 */
export function explainer(say: (line: string) => void, why: (key: string) => string | undefined) {
	const told = new Map<string, string>();
	return (alerts: Map<string, Alert>) => {
		for (const [key, a] of alerts) {
			const reason = a.card?.kind === "dialog" ? why(key) : undefined;
			if (reason === told.get(key)) continue;
			if (reason) (told.set(key, reason), say(`[sb] a question from ${a.name} waits and is not on the Zen page: ${reason}`));
			else told.delete(key);
		}
		for (const key of told.keys()) if (!alerts.has(key)) told.delete(key);
	};
}

/** The key of a wait's alert (waits.ts `waitAlerts`). */
const waitKey = (ws: string, id: string) => `wait\u001f${ws}\u001f${id}`;
/**
 * The dialogs headless runs wait on, as Zen's cards (docs/specs/2026-11-24-zen-f.md §2, §7.5), added to `alerts`: one card per dialog, blocking, aged from when it came (`at`). A dialog a run's `boss_wait_ask` draws (`wait`) is no card of its own: it is that wait card,
 * which is then `asked` (it blocks while the run's turn holds on it, ZF-3). `unit` is the tower's key (the head's for a head run), so the card's context is that tower's log.
 */
export function withRuns(alerts: Map<string, Alert>, net: Net | undefined, dialogs: RunDialog[], at: number): Map<string, Alert> {
	if (!dialogs.length) return alerts;
	const out = new Map(alerts);
	for (const d of dialogs) {
		if (d.wait) {
			const key = [waitKey(d.wait.workspace, d.wait.id), ...(d.run === "head" ? [waitKey(HEAD_KEY, d.wait.id)] : [])].find((k) => out.has(k)), w = key ? out.get(key) : undefined;
			if (key && w?.wait) out.set(key, { ...w, wait: { ...w.wait, asked: true } });
			continue;
		}
		const head = d.run === "head", base = net?.bases.find((b) => b.id === d.workspace), unit = head ? net?.head?.key : base?.tower?.key;
		out.set(`run\u001f${d.key}`, { key: `run\u001f${d.key}`, ...(unit ? { unit } : {}), ws: head ? HEAD_KEY : d.workspace, name: head ? "" : (d.label ?? base?.label ?? d.workspace), role: head ? "head" : "tower", mark: "waiting", at, ...(d.at !== undefined ? { since: d.at } : {}), card: { kind: "run", dialog: d } });
	}
	return out;
}
