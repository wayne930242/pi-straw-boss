import type { SessionPost } from "./answer.ts";
import type { AnswerPost } from "./ask.ts";
import { remoteAnswer } from "./linkdialogmodel.ts";
import { m } from "./sentences.ts";
import { type Answer, post } from "./post.ts";
import type { NetRoute } from "./router.ts";
import { towerRoute } from "./towermodel.ts";
import { HEAD_KEY } from "../src/headkey.ts";
import type { RunDialog } from "../src/net.ts";

// What the boss's answers have in common, decided once for every view (docs/specs/2026-11-01-zen-view.md, Answering): how a reply to an answer reads. The routes say it in their own words: a dialog or trust answer has an `outcome`, a message to a tower
// (the session's `input`) says `accepted: true`, and the tower memory route (a dismissed wait) answers the memory it now holds. A view reads them through `outcome` and acts on one of three: Standard closes its dialog, Zen's model knocks or plays the low bowl.

export type Outcome = "accepted" | "unknown" | "refused";
/** What a reply meant: the owner took it, did not say (Check again), or it was refused. A reply with an `outcome` is judged by it alone. */
export const outcome = (r: Pick<Answer, "ok" | "status" | "body">): Outcome => {
	const said = r.body.outcome;
	if (said !== undefined) return said === "accepted" ? "accepted" : said === "unknown" ? "unknown" : "refused";
	if (r.status === 504) return "unknown";
	return r.ok && (r.body.accepted === true || Array.isArray(r.body.entries)) ? "accepted" : "refused";
};
/** A plain English reason after "did not take it:" starts in lower case; an acronym or other script stays. */
export const joined = (reason: string) => reason.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase());

/** The wait the actions are about: its workspace, its id in the tower's memory, and the tower's session key (where the boss's words go). */
export interface WaitTarget { ws: string; id: string; tower: string }
export interface WaitActions {
	/** The boss's words to the tower: the session's `input`, the route Standard's composer sends to (`send` is `answerPost` of the tower's key, or the demo fixture's stand-in). */
	tell(text: string): Promise<Answer>;
	/** A button of a wait card (docs/specs/2026-11-07-wait-cards.md, The press): the memory route's `press`, which tells the tower and the raiser. `decline` is Skip (a second tap, with its optional reason); `secret` is the first step of a secret card. */
	press(act: "done" | "choose" | "secret" | "decline" | "restate", extra?: { option?: number; reason?: string }): Promise<Answer>;
	/** The memory, whole: a card the snapshot cut to its text is read from it when it is drawn (`entries` carry `card` and `press`). */
	read(): Promise<Answer>;
	/** The tower's comms: the one action that navigates, offered as a link. */
	goto: NetRoute;
}
/** What the boss can do with a wait the tower recorded on them, as plain functions every view draws (waitcard.ts, waitpanel.ts); a view differs only in what it does after `outcome` of the reply. */
export const waitActions = (w: WaitTarget, send: SessionPost): WaitActions => ({
	tell: (text) => send("input", { text, as: "send", answers: w.id }), // `answers`: the server marks this wait answered once the tower took the message, so no view raises it again
	press: (act, extra) => post(`${towerRoute(w.ws)}/memory`, { op: "press", id: w.id, act, ...extra }), // the head's waits go to `head/memory`
	read: () => post(`${towerRoute(w.ws)}/memory`, { op: "read" }),
	goto: { view: "session", ws: w.ws, key: w.tower },
});

// The other answers a boss gives, as plain requests. Standard's rows (linkbar.ts, linkdialogs.ts, lan.ts, towernotes.ts) and Zen's cards (zendecide.ts, zen.ts) both call these, so a trust decision is made by one function whichever view shows it.

/** A route whose success is only its HTTP status (a link answer, a LAN decision) reads as accepted; a refusal is as the server gave it. */
export const taken = (r: Answer): Answer => (r.ok && r.body.outcome === undefined ? { ...r, body: { ...r.body, outcome: "accepted" } } : r);

/** Allow or Deny for a confirm a teammate's tower asked of this computer (`link/confirm-answer`; the holder checks the request is still open). */
export const confirmActions = (c: { dialogId: string; digest: string }) => {
	const answer = (allow: boolean) => post("link/confirm-answer", { dialogId: c.dialogId, digest: c.digest, allow }).then(taken); // the digest names the request the boss saw: the holder refuses it when the held request carries another digest (the route requires it); it is the sender's digest, so it does not vouch for the arguments
	return { allow: () => answer(true), deny: () => answer(false) };
};
/** A confirm refusal in the page's language: the holder's known refusals have a message each; any other reason is the server's own. */
export const confirmWhy = (r: Pick<Answer, "status" | "body">): string => {
	const said = String(r.body.reason ?? r.body.error ?? "");
	const known: [RegExp, () => string][] = [[/^That request is gone/, m.link_confirm_gone], [/^That team is not running/, m.link_confirm_team_off], [/^That request changed/, m.link_confirm_changed]];
	return known.find(([re]) => re.test(said))?.[1]() ?? (said || m.refused({ status: r.status }));
};

/** A dialog an unattended device forwarded: the panel's answer goes to `link/dialog-answer`; the holder checks the device, dialog and digest again (src/link/dialogs-out.ts `answerDialog`), so the panel only says which choice or words. */
export interface ForwardedDialog { device: string; dialogId: string; digest: string }
export const forwardedAnswer = (d: ForwardedDialog): AnswerPost => async (_action, body) => {
	const r = await post("link/dialog-answer", { device: d.device, dialogId: d.dialogId, digest: d.digest, answer: remoteAnswer(body) });
	return r.ok ? taken(r) : { ok: false, status: r.status, body: { reason: m.link_dialog_error({ reason: r.body.reason ?? m.refused({ status: r.status }) }) } };
};

/** Confirm or Reject for a memory proposal a tower run made (the memory route of its workspace; a confirm names the rev the snapshot carried). */
export const proposalActions = (p: { ws: string; id: string; rev: () => number }) => ({
	confirm: () => post(`${towerRoute(p.ws)}/memory`, { op: "confirm", proposal: p.id, rev: p.rev() }), // read when pressed: the memory moves while a card is shown, and a stale rev is refused
	reject: () => post(`${towerRoute(p.ws)}/memory`, { op: "reject", proposal: p.id }),
});

/** A pair request's decision (`lan/approve`, this computer's page only): the number the phone shows, one request's id, or all. `send` is the page's `post`, or the Wi-Fi tab's own. */
export const lanActions = (send: (path: string, body: Record<string, unknown>) => Promise<Answer>) => ({
	approve: (number: string) => send("lan/approve", { number }).then(taken),
	deny: (id: string) => send("lan/approve", { deny: id }).then((r) => (r.ok && r.body.denied === 0 ? { ...r, ok: false, body: { error: "gone", reason: m.lan_request_gone() } } : taken(r))), // the server answers 200 for an id it no longer holds (answered elsewhere, timed out)
	denyAll: () => send("lan/approve", { deny: "all" }).then(taken),
});
/** What a decision's reply says: `answer` under the field (nothing for a success, or when the whole budget was spent), `verdict` for three wrong numbers in a row, which denied every request. */
export function lanReading(r: Pick<Answer, "ok" | "status" | "body">): { answer: string; verdict: string } {
	const budget = !r.ok && r.body.error === "no_match" && Number(r.body.denied) > 0;
	return { answer: r.ok || budget ? "" : r.body.error === "no_match" ? m.lan_no_match() : String(r.body.reason ?? m.refused({ status: r.status })), verdict: budget ? m.lan_wrong_budget() : "" };
}

/**
 * A headless run's dialog (docs/specs/2026-11-24-zen-f.md §2.3): one send path for Standard's rows (rundialogs.ts) and Zen's run card (zenrun.ts), so the body (`key`, `confirmed`, `value`, `cancelled`) and the route are the same in every view. `ws` is the page's
 * workspace (the head's page: `HEAD_KEY`, whose route lists every run's dialogs); without it a head run's dialog goes to the head's route and any other to its own tower's. The route's 200 reads as accepted (`taken`).
 */
export const runDialogActions = (d: Pick<RunDialog, "key" | "workspace" | "run">, ws = d.run === "head" ? HEAD_KEY : d.workspace, send: (path: string, body: Record<string, unknown>) => Promise<Answer> = post) => {
	const answer = (reply: { confirmed?: boolean; value?: string; cancelled?: true }) => send(`${towerRoute(ws)}/dialog`, { key: d.key, ...reply }).then(taken);
	return { answer, yes: () => answer({ confirmed: true }), no: () => answer({ confirmed: false }), value: (value: string) => answer({ value }), cancel: () => answer({ cancelled: true }) };
};
