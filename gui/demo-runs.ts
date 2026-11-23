import type { Net, RunDialog, TowerService } from "../src/net.ts";

// The demo's headless runs (docs/specs/2026-11-24-zen-f.md §7.16), for pictures and a hand check with no server. `?zen=run-approval|run-select|run-input|run-ended|run-expired`: one dialog of Harbor API's run waits, and Enter takes its card two seconds in
// (`&queued` leaves it waiting, the cue counting it); `run-ended` ends the run and `run-expired` lets the dialog time out four seconds after the card is on the screen. `&rundialog=<ms>`: the dialog arrives that long after the start instead, queued.
// `?zen=head-pick`: the head's input unfolded with the target list open. `?zen=addressed`: Harbor API's tower addressed from the list, its conversation the companion with a run's message under way (`live`); `&notower` addresses Quarry Tools, which has no tower yet.
// `&headless` (any state, Standard's head page too): the head and the towers run headless, so the target button shows. A dialog's answer is the demo's own `api/tower/<ws>/dialog` or `api/head/dialog`.

export const RUN_STATES = ["run-approval", "run-select", "run-input", "run-ended", "run-expired"] as const;
const isRun = (zen: string | null) => (RUN_STATES as readonly string[]).includes(zen ?? "");
/** The states that need headless runs on the net. */
export const runsHeadless = (zen: string | null, q: URLSearchParams) => isRun(zen) || zen === "head-pick" || zen === "addressed" || q.has("headless") || q.has("rundialog");
const RUN = "r7";

function dialogOf(zen: string, at: number, zh: boolean): RunDialog {
	const base = { workspace: "w1", run: "local" as const, label: "Harbor API", at };
	if (zen === "run-select") return { ...base, key: `${RUN}:s1`, method: "select", title: zh ? "要從哪個分支發布？" : "Which branch do we release from?", options: ["main", "release/0.85", zh ? "都不要" : "Neither"] };
	if (zen === "run-input") return { ...base, key: `${RUN}:i1`, method: "input", title: zh ? "這次發布的版本號？" : "The version number for this release?" };
	return { ...base, key: `${RUN}:sb-req1`, method: "confirm", approval: true, title: zh ? "邀請 merlin-box 加入 waydosoft（無人值守）" : "Invite merlin-box to waydosoft (unattended)", message: "action   invite-unattended\nteam     waydosoft\ndevice   merlin-box\nreason   " + (zh ? "夜間在盒子上跑 CI" : "run CI on the box overnight") };
}

export interface RunsIo { net(): Net; change(mut: (n: Net) => void): void; send(type: string, payload: unknown): void; service(): TowerService }

export function runsFromUrl(zen: string | null, io: RunsIo) {
	const q = new URLSearchParams(location.search), zh = /^zh/i.test(document.documentElement.lang || navigator.language);
	if (!runsHeadless(zen, q)) return;
	// Headless runs on the net: the head's service and Harbor API's say so, and Harbor API's run is live.
	io.change((n) => {
		if (n.head?.service) n.head.service.headless = true;
		for (const b of n.bases) if (b.tower) b.tower.service = { ...(b.tower.service ?? io.service()), headless: true };
		const harbor = n.bases[0]!.tower!.service!;
		if (isRun(zen) || zen === "addressed" || q.has("rundialog")) harbor.run = { id: RUN, kind: "local", startedAt: new Date().toISOString() };
	});
	let dialogs: RunDialog[] = [];
	const say = () => io.send("run-dialogs", dialogs);
	// The dialog route: the run takes the answer and goes on; the dialog leaves the list.
	const real = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!/api\/(tower\/[^/]+|head)\/dialog$/.test(url)) return real(input, init);
		const key = (JSON.parse(String(init?.body)) as { key?: string }).key;
		const had = dialogs.some((d) => d.key === key);
		dialogs = dialogs.filter((d) => d.key !== key);
		setTimeout(say, 300);
		return new Response(JSON.stringify(had ? { ok: true } : { error: "gone", reason: "That dialog is not waiting any more (it was answered, cancelled, or its run ended)." }), { status: had ? 200 : 409, headers: { "content-type": "application/json" } });
	};
	if (isRun(zen) || q.has("rundialog")) {
		const after = Number(q.get("rundialog") ?? 600), state = isRun(zen) ? zen! : "run-approval";
		setTimeout(() => {
			const at = state === "run-expired" ? Date.now() - 10 * 60_000 + 8000 : Date.now();
			dialogs = [dialogOf(state, at, zh)];
			say();
			if (state === "run-ended") setTimeout(() => ((dialogs = []), io.change((n) => delete n.bases[0]!.tower!.service!.run), say()), 6000);
			if (state === "run-expired") setTimeout(() => ((dialogs = []), say()), 8200);
		}, after);
		if (isRun(zen) && !q.has("queued")) setTimeout(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })), after + 1400);
	}
	const click = (sel: string, at: number) => setTimeout(() => document.querySelector<HTMLElement>(sel)?.click(), at);
	if (zen === "head-pick" || zen === "addressed") {
		setTimeout(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })), 1800);
		click("#zen .zen-head .target-btn", 2400);
	}
	if (zen === "addressed") {
		const ws = q.has("notower") ? "w4" : "w1";
		setTimeout(() => [...document.querySelectorAll<HTMLElement>("#zen .target-row")].find((r) => r.textContent?.startsWith(ws === "w4" ? "Quarry Tools" : "Harbor API"))?.click(), 3000);
		// The run's message under way, at the server's pace: it grows every two seconds, and the session file's entry would take its place.
		const words = zh ? ["正在看", " train 2026-11-24-a", " 的狀態，", "等我一下"] : ["Looking at", " train 2026-11-24-a", " to see where it stands,", " one moment"];
		let n = 0;
		if (ws === "w1") setInterval(() => io.send("history", { key: "t1", items: [], live: words.slice(0, (n++ % words.length) + 1).join("") }), 2000);
	}
}
