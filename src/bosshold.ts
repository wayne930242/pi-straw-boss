import type { LinkDeps } from "./bosslink.ts";
import { firstWord } from "./bossopen.ts";
import { line } from "./safetext.ts";
import type { Kit } from "./state.ts";

// `/boss link hold | release | holds | held [end]` (docs/specs/2026-11-26-device-hold.md, Tools and commands): the boss's typed device holds. Each posts to the route the page would (`link/hold`, `release`, `holds`, `held`, `held-end`),
// so the holder keeps every check; `hold` and `held end` are confirmed first. The holding main is this session unless `--main` names another. Labels a teammate wrote are read through `line`.

export type HoldLine = { action: "hold"; device: string; main?: string; hours?: string } | { action: "release"; device: string } | { action: "holds" } | { action: "held"; end: boolean };

/** A line after `/boss link` that is one of these: its parts, "usage" when malformed, undefined when it is not one of them. */
export function parseHold(rest: string | undefined): HoldLine | "usage" | undefined {
	const words: string[] = [];
	for (let r = (rest ?? "").trim(); r;) ({ word: words[words.length], rest: r } = firstWord(r));
	const [verb, ...more] = words;
	if (verb === "holds") return more.length ? "usage" : { action: "holds" };
	if (verb === "held") return !more.length ? { action: "held", end: false } : more.length === 1 && more[0] === "end" ? { action: "held", end: true } : "usage";
	if (verb === "release") return more.length === 1 ? { action: "release", device: more[0]! } : "usage";
	if (verb !== "hold") return undefined;
	const out: { device?: string; main?: string; hours?: string } = {};
	for (let i = 0; i < more.length; i++) {
		const w = more[i]!, flag = /^--(main|hours)(?:=(.+))?$/.exec(w);
		if (flag) { const v = flag[2] ?? more[++i]; if (!v) return "usage"; out[flag[1] as "main" | "hours"] = v; } else if (out.device === undefined && !w.startsWith("--")) out.device = w; else return "usage";
	}
	return out.device ? { action: "hold", device: out.device, ...(out.main ? { main: out.main } : {}), ...(out.hours ? { hours: out.hours } : {}) } : "usage";
}

export const HOLD_ARGUMENTS = Object.entries({ "link hold": "Hold a teammate's unattended box for a main here: link hold <box> [--main <name|key>] [--hours n]", "link release": "Release this computer's hold of a box: link release <box>", "link holds": "List this computer's holds and whether each box honours it", "link held": "Show which teammate holds this box (link held end ends it here)" }).map(([value, description]) => ({ value, label: value, description }));

const ago = (ms: number) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);
const WORDS = {
	en: {
		usage: "/boss link hold <box> [--main <name|key>] [--hours n] | release <box> | holds | held [end]",
		holdTitle: (box: string) => `Hold ${box}?`,
		holdBody: (box: string, main: string, hours: string) => `${main} holds ${box}${hours ? ` for ${hours} h` : " while it runs"}. The box tells its own mains to start no new work, gives its free room to that main, and opens worker slips from this computer only.`,
		thisSession: "this session",
		endTitle: "End the hold here?", endBody: (who: string) => `${who} holds this box. Ending it here makes the box take its own work again and tells that device; its board's hold is refused here from now on.`,
		declined: "Nothing was changed",
		noHolds: "This computer holds no box",
		holdsHead: "Holds from this computer:",
		holdRow: (box: string, main: string, since: string, until: string, honoured: boolean, board: string) => `  ${box} · ${main} · since ${since} ago${until} · ${honoured ? "honoured" : "not honoured (the box's policy level, its build, or its board has not echoed it yet)"}${board}`,
		ended: (box: string, reason: string, when: string) => `  ended: ${box} · ${reason} · ${when} ago`,
		notHeld: "No teammate holds this box",
		held: (who: string, since: string, until: string) => `Held by ${who} since ${since} ago${until}. /boss link held end ends it here.`,
	},
	"zh-TW": {
		usage: "/boss link hold <box> [--main <名稱|key>] [--hours n] | release <box> | holds | held [end]",
		holdTitle: (box: string) => `接管 ${box}？`,
		holdBody: (box: string, main: string, hours: string) => `由 ${main} 接管 ${box}${hours ? `，為期 ${hours} 小時` : "，直到它結束"}。那台機器會叫它自己的 main 不再接新工作、把空出的容量留給這個 main，並只接受這台電腦送去的 worker 單。`,
		thisSession: "這個 session",
		endTitle: "在這裡結束接管？", endBody: (who: string) => `${who} 正在接管這台機器。在這裡結束後，這台機器會恢復接自己的工作並通知對方裝置；之後它看板上的接管一律不予理會。`,
		declined: "沒有變更任何東西",
		noHolds: "這台電腦沒有接管任何機器",
		holdsHead: "這台電腦的接管：",
		holdRow: (box: string, main: string, since: string, until: string, honoured: boolean, board: string) => `  ${box} · ${main} · ${since} 前開始${until} · ${honoured ? "已生效" : "未生效（那台機器的 policy 等級、版本，或它的看板尚未回應）"}${board}`,
		ended: (box: string, reason: string, when: string) => `  已結束：${box} · ${reason} · ${when} 前`,
		notHeld: "沒有隊友接管這台機器",
		held: (who: string, since: string, until: string) => `由 ${who} 接管，${since} 前開始${until}。/boss link held end 可在這裡結束。`,
	},
};

export function createBossHold({ tell, me }: Pick<Kit, "tell" | "me">, { record, post, why, confirm, lang }: Omit<LinkDeps, "here">) {
	const t = () => WORDS[lang()];
	const call = async (path: string, json: Record<string, unknown>) => { const r = await post(await record(), `link/${path}`, json, 30_000); return r.status === 200 ? r.body : (tell(why(r), "error"), undefined); };
	return {
		handles: (rest: string | undefined) => parseHold(rest) !== undefined,
		async run(rest: string) {
			const p = parseHold(rest), now = Date.now();
			if (p === undefined) return;
			if (p === "usage") return tell(t().usage, "error");
			if (p.action === "hold") {
				if (!(await confirm(t().holdTitle(line(p.device)), t().holdBody(line(p.device), p.main ? line(p.main) : t().thisSession, p.hours ? line(p.hours) : ""), true))) return tell(t().declined);
				const b = await call("hold", { session: me(), device: p.device, ...(p.main ? { main: p.main } : {}), ...(p.hours ? { hours: p.hours } : {}) });
				return b && tell(line(String(b.text ?? "")));
			}
			if (p.action === "release") { const b = await call("release", { device: p.device }); return b && tell(line(String(b.text ?? ""))); }
			if (p.action === "holds") {
				const b = await call("holds", {});
				if (!b) return;
				const holds = (b.holds ?? []) as { label: string; short: string; main: string; since: number; until?: number; honoured: boolean; boxBoardSecondsAgo?: number }[], ended = (b.ended ?? []) as { short: string; at: number; reason: string }[];
				if (!holds.length && !ended.length) return tell(t().noHolds);
				return tell([t().holdsHead, ...holds.map((h) => t().holdRow(`${line(h.label)} (${line(h.short)})`, line(h.main), ago(now - h.since), h.until ? ` · until ${new Date(h.until).toISOString().slice(11, 16)}Z` : "", h.honoured, h.boxBoardSecondsAgo !== undefined ? ` · box board ${ago(h.boxBoardSecondsAgo * 1000)} ago` : "")), ...ended.map((e) => t().ended(line(e.short), line(e.reason), ago(now - e.at)))].join("\n"));
			}
			const b = await call("held", {});
			const h = b?.held as { label: string; short: string; byName: string; since: number; until?: number } | undefined;
			if (!b) return;
			if (!h) return tell(t().notHeld);
			const who = `main "${line(h.byName)}" on ${line(h.label)} (${line(h.short)})`;
			if (!p.end) return tell(t().held(who, ago(now - h.since), h.until ? ` · until ${new Date(h.until).toISOString().slice(11, 16)}Z` : ""));
			if (!(await confirm(t().endTitle, t().endBody(who), true))) return tell(t().declined);
			const done = await call("held-end", {});
			return done && tell(line(String(done.text ?? "")));
		},
	};
}
