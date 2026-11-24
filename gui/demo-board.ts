import type { BoardViewRow } from "../src/boardview.ts";
import type { Net, Unit } from "../src/net.ts";
import { getLocale } from "./paraglide/runtime.js";

// The demo's work board (`?board` on the head page, docs/specs/2026-11-09-board-view.md): eight rows over two workspaces on top of the demo net, one of each kind the section draws: a live main with items, a stale idle main (clearable), an ended row,
// an ended row whose session is still open (`open`), a live main with no line, a train row, one long line, and one whose line is markup (it must show as text). Ask progress and Clear are answered here, with no server: Ask is accepted; the first Clear
// reads "cleared, told it" and every other one "cleared, the reminder is queued". `?board` takes the head tower's `talk` state unless `?head=` says another.

const MIN = 60_000, said = (zh: string, en: string) => (getLocale() === "en" ? en : zh);
const unit = (key: string, name: string, role: Unit["role"], mark: Unit["mark"]): Unit => ({ id: key, key, control: true, name, role, mark, note: undefined, subs: [] });

export function boardRows(now: number): BoardViewRow[] {
	const row = (session: string, workspace: string, tab: string, main: string, state: string, over: Partial<BoardViewRow> = {}): BoardViewRow => ({ session, workspace, tab, main, state, items: [], ...over });
	return [
		row("bd-work", "Board Alpha", "api", "api-fix", "working", { now: said("修好帳本稅前進位，正在補退款情境的測試", "Fixed the ledger rounding before tax; adding the credit-note test"), src: "set", updated: now - 3 * MIN, items: [{ t: said("找出進位的位置", "Find where the rounding happens"), done: true }, { t: said("稅前進位修正", "Fix the rounding before tax"), done: true }, { t: said("退款情境測試", "Credit-note regression test"), done: false }, { t: said("更新 changelog", "Update the changelog"), done: false }] }),
		row("bd-long", "Board Alpha", "api", "docs-pass", "working", { now: said("正在逐頁檢查整份文件：", "Going through the whole manual page by page: ") + said("安裝、設定、疑難排解、發佈流程、每個指令的範例與輸出、各平台的差異、升級指引、已知問題與對應的暫行辦法，然後再回頭核對每個章節的連結與目錄是否一致，最後把改動整理成一份給審稿人看的摘要。", "install, setup, troubleshooting, the release flow, an example and the output for every command, the differences between platforms, upgrade notes, the known problems and their workarounds, then back to check that every section's links and the table of contents agree, and last a summary of the changes for the reviewer to read."), src: "set", updated: now - 9 * MIN }),
		row("bd-idle", "Board Alpha", "web", "web-polish", "idle", { now: said("等圖檔改完再接著做首頁", "Waiting for the images before the home page"), src: "set", updated: now - 5 * 60 * MIN, stale: true, clearable: true }),
		row("bd-bare", "Board Alpha", "web", "web-new", "idle"),
		row("bd-markup", "Board Beta", "mobile", "mobile-spike", "working", { now: "<img src=x onerror=alert(1)> **not bold** [not a link](https://example.com)", src: "set", updated: now - 40_000 }),
		{ ...row("bd-train", "Board Beta", "trains", "train 1109a", "working", { now: said("第二輪：unit 測試跑到一半", "Round 2: the unit tests are half way"), src: "set", updated: now - 2 * MIN }), role: "train" },
		row("bd-ended", "", "", "old-main", "ended", { now: said("上線檢查做完了", "The launch check is done"), src: "todo", updated: now - 26 * 60 * MIN, count: { done: 5, total: 5 }, clearable: true }),
		row("bd-open", "", "", "web-helper", "ended", { now: said("改當成員，不再是 main", "Became a member, no longer a main"), src: "set", updated: now - 7 * 60 * MIN, clearable: true, open: true }),
	];
}

/** `?board` puts the board and the units of its live rows on the demo net, and answers the page's two acts (Ask progress, Clear) through `fetch` without a server. `update` hands a change of the net to the fixture, which sends the new snapshot. */
export function boardFromUrl(net: Net, now: number, update: (change: (n: Net) => void) => void): void {
	if (!new URLSearchParams(location.search).has("board")) return;
	const rows = boardRows(now), mark = (r: BoardViewRow) => (r.state === "working" ? "working" : "idle") as Unit["mark"];
	const base = (id: string, label: string, tab: string, keys: string[]) => ({ id, label, mark: "working" as const, tower: null, tabs: [{ id: `${id}:${tab}`, label: tab, units: keys.map((k) => { const r = rows.find((x) => x.session === k)!; return unit(k, r.main, r.role ?? "main", mark(r)); }) }], outposts: [], outside: [] });
	net.bases.push(base("bw-alpha", "Board Alpha", "api", ["bd-work", "bd-long", "bd-idle", "bd-bare"]), base("bw-beta", "Board Beta", "mobile", ["bd-markup", "bd-train"]));
	Object.assign(rows[0]!, { points: 6, ready: 5 });
	net.capacity = { points: 6, budget: 20, load1: 0.24, cores: 8, ready: 5, paused: 0 };
	net.board = rows;
	let cleared = 0;
	const real = globalThis.fetch, json = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	globalThis.fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (/api\/sessions\/bd-[^/]+\/input$/.test(url)) return json({ accepted: true, woke: true });
		if (url.endsWith("api/board/clear")) {
			const { session } = JSON.parse(String(init?.body)) as { session: string };
			update((n) => void (n.board = n.board?.filter((r) => r.session !== session)));
			return json({ cleared: true, told: cleared++ === 0 ? "delivered" : "queued" });
		}
		return real(input, init);
	};
}
