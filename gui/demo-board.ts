import type { Plan } from "../src/boardplan.ts";
import type { BoardViewRow } from "../src/boardview.ts";
import type { Todo } from "../src/items.ts";
import type { Net, Unit } from "../src/net.ts";
import { getLocale } from "./paraglide/runtime.js";

// The demo's work board (`?board` on the head page, docs/specs/2026-11-09-board-view.md): eight rows over two workspaces on top of the demo net, one of each kind the section draws: a live main with items, a stale idle main (clearable), an ended row,
// an ended row whose session is still open (`open`), a live main with no line, a train row, one long line, and one whose line is markup (it must show as text). Ask progress and Clear are answered here, with no server: Ask is accepted; the first Clear
// reads "cleared, told it" and every other one "cleared, the reminder is queued". `?board` takes the head tower's `talk` state unless `?head=` says another. The rows carry the supply board's figures (below).

const MIN = 60_000, said = (zh: string, en: string) => (getLocale() === "en" ? en : zh);
const unit = (key: string, name: string, role: Unit["role"], mark: Unit["mark"]): Unit => ({ id: key, key, control: true, name, role, mark, note: undefined, subs: [] });

/** The plan of api-fix's auto line (`?board`, gui/plangraph.ts): a fix in progress, three checks that fan out from it to workers, their merge, the boss's sign-off it waits on until 14:00, and the changelog after it; beside them a question that waits on finance. */
export function demoPlan(now: number): Plan {
	const at = (days: number, hour: number) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
	return { graph: "fan-out/fan-in", nodes: [
		{ id: 3, t: said("稅前進位修正", "Fix the rounding before tax"), status: "in_progress", owner: "api-fix" },
		{ id: 4, t: said("退款情境測試", "Credit-note regression test"), status: "pending", owner: "worker-api", after: [3] },
		{ id: 5, t: said("發票 PDF 金額核對", "Check the invoice PDF totals"), status: "pending", owner: "worker-web", after: [3] },
		{ id: 6, t: said("帳本匯出核對", "Check the ledger export"), status: "pending", owner: "worker-db", after: [3] },
		{ id: 7, t: said("合併三項檢查", "Merge the three checks"), status: "pending", after: [4, 5, 6] },
		{ id: 8, t: said("老闆簽核上線", "Boss signs off the release"), status: "pending", after: [7], wait: { on: said("老闆", "boss"), until: at(0, 14) } },
		{ id: 9, t: said("更新 changelog", "Update the changelog"), status: "pending", after: [8] },
		{ id: 10, t: said("問財務新的進位規則", "Ask finance about the new rounding rule"), status: "pending", wait: { on: said("財務", "finance"), until: at(1, 10) } },
	] };
}
/** `?plan`: a session page's todo list carries the same plan (owners, blockers, defers), so its todo box draws the graph in place of the checklist. */
export function demoTodos(): Todo[] | undefined {
	if (!new URLSearchParams(location.search).has("plan")) return undefined;
	const done: Todo[] = [{ id: 1, subject: said("找出進位的位置", "Find where the rounding happens"), status: "completed" }, { id: 2, subject: said("重現錯誤", "Reproduce the error"), status: "completed" }];
	return [...done, ...demoPlan(Date.now()).nodes.map((n): Todo => ({ id: n.id, subject: n.t, status: n.status, ...(n.owner ? { owner: n.owner } : {}), ...(n.after ? { blockedBy: n.after } : {}), ...(n.wait?.on ? { waitsOn: n.wait.on } : {}), ...(n.wait?.until ? { until: n.wait.until } : {}), graph: "fan-out/fan-in" }))];
}

export function boardRows(now: number): BoardViewRow[] {
	const row = (session: string, workspace: string, tab: string, main: string, state: string, over: Partial<BoardViewRow> = {}): BoardViewRow => ({ session, workspace, tab, main, state, items: [], ...over });
	return [
		row("bd-work", "Board Alpha", "api", "api-fix", "working", { now: said("api-fix：修正稅前進位", "api-fix: Fixing the rounding before tax"), src: "todo", count: { done: 2, total: 10 }, plan: demoPlan(now), updated: now - 3 * MIN, items: [{ t: said("找出進位的位置", "Find where the rounding happens"), done: true }, { t: said("稅前進位修正", "Fix the rounding before tax"), done: true }, { t: said("退款情境測試", "Credit-note regression test"), done: false }, { t: said("更新 changelog", "Update the changelog"), done: false }] }),
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
	// The supply board (docs/specs/2026-11-24-capacity-supply/spec.md): api-fix runs three units of 2 points with 5 ready, docs-pass waits on its quota, web-polish is stale, the others run nothing; a teammate device is out of touch. `?board=unset`: no budget.
	const zero = { points: 0, ready: 0, units: [] };
	Object.assign(rows[0]!, { points: 6, ready: 5, units: ["api-build", "web-test", "db-check"].map((name) => ({ name, points: 2 })) });
	Object.assign(rows[1]!, zero, { paused: "quota", pausedUntil: now + 40 * MIN });
	for (const r of [rows[2]!, rows[3]!, rows[4]!]) Object.assign(r, zero);
	const unset = new URLSearchParams(location.search).get("board") === "unset";
	net.capacity = { points: 6, ...(unset ? {} : { budget: 20, underMinutes: 12 }), load1: 0.24, cores: 8, ready: 5, paused: 1 };
	net.link?.allies.push({ id: "t/box01", team: "t", teamName: "moldplan", device: "box01", short: "b01", label: "Box 01", online: false, workspace: null, tower: "unknown", tabs: [] });
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
