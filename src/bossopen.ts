import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { TrustPrompt } from "./deploy.ts";
import type { GuiRecord } from "./handover.ts";
import type { DeviceUnits, LinkView } from "./link/holder.ts";
import type { Here } from "./heremark.ts";
import { hereOnlyOpts } from "./intercept.ts";
import { LIMITS } from "./link/kinds.ts";
import type { Lang } from "./memorycmd.ts";
import { line } from "./safetext.ts";
import type { Kit } from "./state.ts";

// The boss's typed twins of the page's + Base, + Member, + Main (`/boss open base|member|main`) and of the Straw Link join requests (`/boss link [status]`, `link decide <id> approve|refuse`). Like bosspaths.ts
// each posts to the route the page posts to, so the server keeps every check (a folder under home, one opening at a time, project trust, who may decide a join request); this side parses the line, words the
// answer, and asks in pi what the page asks in its dialogs. They are the boss's typed input only: boss.ts refuses them in a tower run or an ally run, and no tool reaches this module. A paired device may open and
// read the teams (the routes allow it) but not decide: `link decide` is in control.ts's BOSS_LOCAL.

const OPEN_MS = 12 * 60_000, POLL_MS = 500, SHOWN = 5;
type Reply = { status: number; body: Record<string, unknown> };
type Post = (record: GuiRecord, path: string, json: Record<string, unknown>, timeoutMs: number) => Promise<Reply>;
const WORDS = {
	en: {
	openUsage: "/boss open base <dir> [label] | open member [dir] | open main <dir> [prompt]: a new base with one member, a member (beside this session, or in a tab of its own in <dir>), or a main in a tab of this base",
		openNeedDir: (kind: string) => `open ${kind} needs a folder: /boss open ${kind} <dir>`,
		openNoDir: (d: string) => `"${d}" is not a folder`,
		openNoBase: "This session is not in a base yet, so there is nothing to add a unit to",
		openMemberText: "open member takes only a folder; the first message goes to the member once it is open",
		opening: (kind: string, name: string) => `Opening ${kind} ${name}…`,
		kindBase: "base", kindMain: "main", kindMember: "member",
		opened: (kind: string, name: string, session: unknown) => `Opened ${kind} ${name}${typeof session === "string" ? ` (session ${session})` : ""}`,
		openFailed: (step: string, why: string) => `Failed at "${step}": ${why}`,
		openTimeout: "The server did not answer in time. The unit may still open: look at the map",
		steps: { createBase: "Create the base", createTab: "Open a tab", createPane: "Split a pane", start: "Start the agent", join: "Join the Straw Net", deliver: "Deliver the task", trust: "Waiting for your OK to trust this folder" } as Record<string, string>,
		trustTitle: "Trust this folder?",
		trustBody: "Trusting lets the agent load this folder's settings, extensions, skills, prompts, themes, and MCP servers, and install the packages its settings list. Extensions and MCP servers run as programs on this computer. Do not trust a folder you do not know.",
		trustFound: "It would load:",
		trustMore: (n: number) => `${n} more`,
		trustUnreadable: "unreadable",
		trustChoices: { trust: "Trust this folder", once: "Trust it this once", no: "Do not trust" } as Record<string, string>,
		trustAnswered: "Answered",
		trustStale: "Already answered in the terminal",
		trustGone: "The agent ended before the answer arrived; nothing was decided",
		trustChanged: "The folder changed after the question was shown, so the answer was not used; the new question is shown next",
		trustBusy: "The answer is being taken; try again in a moment",
		trustUnknown: "The answer was not confirmed; look at the opening",
		trustNoScreen: "The new pi waits on a trust question; answer it in the GUI or in its terminal (this session has no pi screen to ask in)",
		linkUsage: "/boss link [status] | link decide <id> approve|refuse | confirms | confirm <id> allow|deny | asks | answer <id> <choice number | text> | invite show|cancel <hash> | join <invite|@file> | join cancel | create <relay> <dir> | leave <team>",
		linkOff: "Straw Link is not on in this server",
		linkDevice: (label: string, short: string) => `This device: ${label} (${short})`,
		linkNoTeams: "No team yet",
		linkTeam: (name: string, role: string, running: boolean, why: string) => `Team ${name}: you are ${role}; ${running ? "running" : `stopped${why ? ` (${why})` : ""}`}`,
		linkMember: (label: string, short: string, role: string, attended: boolean, online: boolean, self: boolean) => `  ${label} (${short}) · ${role} · ${attended ? "attended" : "unattended"} · ${self ? "this computer" : online ? "online" : "offline"}`,
		linkNoRequests: "No join request is waiting",
		linkRequests: "Join requests waiting (decide with /boss link decide <id> approve|refuse):",
		linkRequest: (id: string, label: string, short: string, team: string, unattended: boolean) => `  ${id}  ${label} (${short}) asks to join ${team}${unattended ? " · unattended" : ""}`,
		linkNoRequest: (q: string) => `No join request is waiting under "${q}": /boss link lists them`,
		linkManyRequests: (q: string) => `More than one join request starts with "${q}"; nothing was done. Give more of the id`,
		linkRoleAdmin: "admin", linkRoleMember: "member",
		linkApproveUnattended: (label: string, short: string, team: string) => `${label} (${short}) is an unattended device (nobody operates it) and asks to join the team ${team}. The device id in the invite stands in for the four words. Let it join?`,
		linkApproveTitle: "Let this device join?",
		linkWords: (label: string, short: string, team: string) => `${label} (${short}) asks to join the team ${team}. Look at ${label}'s screen and choose the four words it shows. A wrong choice ends the invite.`,
		linkNone: "None of these: refuse",
		linkJoined: (label: string, team: string) => `${label} joined ${team}`,
		linkRefused: (label: string) => `Refused ${label}: nobody joined`,
		linkDeclined: "Nothing was decided",
		stopUsage: "/boss link units [box] | link stop <box> <main name | handle start> [--interrupt] [reason]",
		stopReasonLong: (bytes: number, max: number) => `The reason is ${bytes} bytes; the most a stop request carries is ${max}. Nothing was sent: shorten it`,
		unitsNone: "No unattended box has reported its units yet",
		unitsBox: (label: string, short: string, team: string, stale: boolean) => `${label} (${short}) · team ${team}${stale ? " · no status lately: this is its last one" : ""}`,
		unitsUnit: (name: string, state: string) => `  unit ${name} · ${state}`,
		unitsMain: (name: string, state: string, by: string | undefined, handle: string, waits?: string) => `    main ${name} · ${state}${by ? ` · by ${by}` : ""} · ${handle}${waits ? ` · waiting on this computer ${waits}` : ""}`,
		unitsNoStop: "  this box takes no stop requests yet: it needs a pi-straw-boss that lists unit-stop",
		noBox: (q: string, boxes: string[]) => `No box "${q}" has reported its units. Boxes that did:\n${boxes.join("\n")}`,
		manyBoxes: (q: string, boxes: string[]) => `More than one box matches "${q}"; nothing was sent. Give more of its name:\n${boxes.join("\n")}`,
		noMain: (q: string, box: string, mains: string[]) => `No main "${q}" on ${box}. Its mains:\n${mains.join("\n")}`,
		manyMains: (q: string, mains: string[]) => `More than one main matches "${q}"; nothing was sent. Give more of its name or its handle:\n${mains.join("\n")}`,
		candidateBox: (label: string, short: string) => `  ${label} (${short})`,
		candidateMain: (name: string, unit: string, handle: string) => `  ${name} (unit ${unit}) ${handle}`,
		stopNoMains: (box: string) => `${box} lists no mains this computer may stop`,
		stopNoCap: (box: string) => `${box} does not take stop requests yet: it needs a pi-straw-boss that lists unit-stop in its caps`,
		stopAlready: (main: string, box: string) => `${main} on ${box} is already stopping`,
		stopQuiet: (box: string) => `${box} sent no status lately, so its mains may have changed. Look again with /boss link units`,
		stopTitle: "Stop this main?",
		stopModes: { quit: "quit: it quits when it is idle", interrupt: "interrupt: the turn in progress is aborted, then it quits" } as Record<string, string>,
		stopBody: (box: string, main: string, unit: string, by: string, mode: string, reason: string) => `Ask ${box} to stop the main ${main} (unit ${unit}), dispatched by ${by}. Mode: ${mode}.${reason ? ` Reason: ${reason}` : ""} The box decides; it tells you what happened.`,
		stopSelf: "you",
		stopSent: (box: string, main: string, queued: boolean) => `${queued ? "Queued" : "Sent"} the request to stop ${main} on ${box}${queued ? ": the relay has not taken it yet, and it is sent again until it does" : ""}. The box's notice tells what came of it`,
	},
	"zh-TW": {
	openUsage: "/boss open base <資料夾> [名稱] | open member [資料夾] | open main <資料夾> [提示]：開新基地（含一位成員）、加一位成員（在本工作階段旁，或在 <資料夾> 的新分頁），或在本基地開一位主智慧體",
		openNeedDir: (kind: string) => `open ${kind} 需要資料夾：/boss open ${kind} <資料夾>`,
		openNoDir: (d: string) => `「${d}」不是資料夾`,
		openNoBase: "本工作階段還不在任何基地裡，沒有地方可以加單位",
		openMemberText: "open member 只接資料夾；第一則訊息等成員開好後再交給它",
		opening: (kind: string, name: string) => `正在開啟${kind} ${name}…`,
		kindBase: "基地", kindMain: "主智慧體", kindMember: "成員",
		opened: (kind: string, name: string, session: unknown) => `已開啟${kind} ${name}${typeof session === "string" ? `（工作階段 ${session}）` : ""}`,
		openFailed: (step: string, why: string) => `在「${step}」失敗：${why}`,
		openTimeout: "伺服器沒有及時回應。單位可能仍會開好，請看地圖確認",
		steps: { createBase: "建立基地", createTab: "開啟分頁", createPane: "分割窗格", start: "啟動智慧體", join: "加入稻草網", deliver: "交付任務", trust: "等你確認是否信任這個資料夾" } as Record<string, string>,
		trustTitle: "要信任這個資料夾嗎？",
		trustBody: "信任後，智慧體會載入這個資料夾的設定、擴充、技能、提示、佈景主題與 MCP 伺服器，並安裝設定裡列出的套件。擴充與 MCP 伺服器會在這台電腦上當成程式執行。不認得來源的資料夾，請不要信任。",
		trustFound: "會載入的內容：",
		trustMore: (n: number) => `還有 ${n} 項`,
		trustUnreadable: "讀不出來",
		trustChoices: { trust: "信任這個資料夾", once: "只信任這一次", no: "不信任" } as Record<string, string>,
		trustAnswered: "已回答",
		trustStale: "已在終端機回答",
		trustGone: "代理在答案送達前已結束，沒有做任何決定",
		trustChanged: "問題顯示後資料夾又變了，所以沒有採用你的答案；接著會顯示新的問題",
		trustBusy: "正在處理答案，請稍後再試",
		trustUnknown: "答案沒有得到確認，請看這次開啟的結果",
		trustNoScreen: "新的 pi 在等信任問題；請在 GUI 或它的終端機回答（本工作階段沒有 pi 畫面可以問）",
		linkUsage: "/boss link [status] | link decide <id> approve|refuse | confirms | confirm <id> allow|deny | asks | answer <id> <選項編號 | 文字> | invite show|cancel <hash> | join <邀請|@檔案> | join cancel | create <中繼站> <資料夾> | leave <團隊>",
		linkOff: "這個伺服器沒有開 Straw Link",
		linkDevice: (label: string, short: string) => `本裝置：${label}（${short}）`,
		linkNoTeams: "還沒有團隊",
		linkTeam: (name: string, role: string, running: boolean, why: string) => `團隊 ${name}：你是${role}；${running ? "運作中" : `已停止${why ? `（${why}）` : ""}`}`,
		linkMember: (label: string, short: string, role: string, attended: boolean, online: boolean, self: boolean) => `  ${label}（${short}）· ${role} · ${attended ? "有人值守" : "無人值守"} · ${self ? "這台電腦" : online ? "在線" : "離線"}`,
		linkNoRequests: "沒有等待中的加入要求",
		linkRequests: "等待中的加入要求（用 /boss link decide <id> approve|refuse 決定）：",
		linkRequest: (id: string, label: string, short: string, team: string, unattended: boolean) => `  ${id}  ${label}（${short}）要求加入 ${team}${unattended ? " · 無人值守" : ""}`,
		linkNoRequest: (q: string) => `沒有以「${q}」開頭的加入要求：/boss link 會列出`,
		linkManyRequests: (q: string) => `不只一個加入要求的 id 以「${q}」開頭，什麼都沒做。請多給幾碼`,
		linkRoleAdmin: "管理員", linkRoleMember: "成員",
		linkApproveUnattended: (label: string, short: string, team: string) => `${label}（${short}）是無人值守的裝置（沒有人在操作），要求加入團隊 ${team}。邀請裡的裝置 id 取代了四個單字的比對。要讓它加入嗎？`,
		linkApproveTitle: "要讓這台裝置加入嗎？",
		linkWords: (label: string, short: string, team: string) => `${label}（${short}）要求加入團隊 ${team}。看 ${label} 的螢幕，選它顯示的那一組四個單字。選錯會結束這張邀請。`,
		linkNone: "都不是：拒絕",
		linkJoined: (label: string, team: string) => `${label} 已加入 ${team}`,
		linkRefused: (label: string) => `已拒絕 ${label}：沒有人加入`,
		linkDeclined: "什麼都沒有決定",
		stopUsage: "/boss link units [無人機] | link stop <無人機> <主智慧體名稱 | 代號開頭> [--interrupt] [原因]",
		stopReasonLong: (bytes: number, max: number) => `原因有 ${bytes} 位元組；停止請求最多帶 ${max}。什麼都沒送出：請縮短`,
		unitsNone: "還沒有無人值守的機器回報過它的單位",
		unitsBox: (label: string, short: string, team: string, stale: boolean) => `${label}（${short}）· 團隊 ${team}${stale ? " · 最近沒有狀態：這是它最後一次的回報" : ""}`,
		unitsUnit: (name: string, state: string) => `  單位 ${name} · ${state}`,
		unitsMain: (name: string, state: string, by: string | undefined, handle: string, waits?: string) => `    主智慧體 ${name} · ${state}${by ? ` · 派工者 ${by}` : ""} · ${handle}${waits ? ` · 等候本機 ${waits}` : ""}`,
		unitsNoStop: "  這台機器還不接受停止請求：它需要在 caps 列出 unit-stop 的 pi-straw-boss",
		noBox: (q: string, boxes: string[]) => `沒有名為「${q}」的機器回報過單位。回報過的有：\n${boxes.join("\n")}`,
		manyBoxes: (q: string, boxes: string[]) => `不只一台機器符合「${q}」，什麼都沒送出。請多給幾個字：\n${boxes.join("\n")}`,
		noMain: (q: string, box: string, mains: string[]) => `${box} 上沒有「${q}」這個主智慧體。它有：\n${mains.join("\n")}`,
		manyMains: (q: string, mains: string[]) => `不只一個主智慧體符合「${q}」，什麼都沒送出。請多給幾個字的名稱或代號：\n${mains.join("\n")}`,
		candidateBox: (label: string, short: string) => `  ${label}（${short}）`,
		candidateMain: (name: string, unit: string, handle: string) => `  ${name}（單位 ${unit}）${handle}`,
		stopNoMains: (box: string) => `${box} 沒有這台電腦可以停止的主智慧體`,
		stopNoCap: (box: string) => `${box} 還不接受停止請求：它需要在 caps 列出 unit-stop 的 pi-straw-boss`,
		stopAlready: (main: string, box: string) => `${box} 上的 ${main} 已經在停止中`,
		stopQuiet: (box: string) => `${box} 最近沒有回報狀態，它的主智慧體可能已經變了。請先用 /boss link units 重新看一次`,
		stopTitle: "要停止這個主智慧體嗎？",
		stopModes: { quit: "quit：等它閒下來就結束", interrupt: "interrupt：先中止進行中的回合，再結束" } as Record<string, string>,
		stopBody: (box: string, main: string, unit: string, by: string, mode: string, reason: string) => `請 ${box} 停止主智慧體 ${main}（單位 ${unit}），派工者是 ${by}。模式：${mode}。${reason ? `原因：${reason}。` : ""}由那台機器決定，結果會通知你。`,
		stopSelf: "你",
		stopSent: (box: string, main: string, queued: boolean) => `${queued ? "已排入佇列" : "已送出"}停止 ${box} 上 ${main} 的請求${queued ? "：中繼站還沒收下，會一直重送到收下為止" : ""}。結果看那台機器回的通知`,
	},
} as const;

/** One word of a typed line: a quoted run (single or double quotes) or a run without spaces, and what follows it. */
export function firstWord(text: string): { word: string; rest: string } {
	const quoted = /^(["'])(.*?)\1(?:\s+|$)([\s\S]*)$/.exec(text);
	if (quoted) return { word: quoted[2]!, rest: quoted[3]!.trim() };
	const plain = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
	return { word: plain?.[1] ?? "", rest: (plain?.[2] ?? "").trim() };
}

/** `/boss open base|main|member [dir] [text]`: the kind, the folder as typed, and the rest of the line (a base's label, a main's first message). Undefined for any other kind. */
export function parseOpen(rest: string | undefined): { kind: "base" | "main" | "member"; dir?: string; text: string } | undefined {
	const kind = firstWord((rest ?? "").trim());
	if (kind.word !== "base" && kind.word !== "main" && kind.word !== "member") return;
	const dir = firstWord(kind.rest);
	return { kind: kind.word, ...(dir.word ? { dir: dir.word } : {}), text: dir.rest };
}

/** `/boss link [status]`, `link decide <id> approve|refuse`, `link units [box]`, or `link stop <box> <main> [--interrupt] [reason]` (`--interrupt` is the whole word anywhere after the main); "usage" for a malformed units or stop. */
export function parseLink(rest: string | undefined): { action: "status" } | { action: "decide"; id: string; verdict: "approve" | "refuse" } | { action: "units"; device?: string } | { action: "stop"; device: string; main: string; interrupt: boolean; reason: string } | "usage" | undefined {
	const text = (rest ?? "").trim();
	if (!text || text === "status") return { action: "status" };
	const units = /^units(?:\s+([\s\S]*))?$/.exec(text);
	if (units) {
		const device = firstWord((units[1] ?? "").trim());
		return device.rest ? "usage" : { action: "units", ...(device.word ? { device: device.word } : {}) };
	}
	const stop = /^stop(?:\s+([\s\S]*))?$/.exec(text);
	if (stop) {
		const device = firstWord((stop[1] ?? "").trim()), main = firstWord(device.rest);
		if (!device.word || !main.word) return "usage";
		const words = main.rest.split(/\s+/).filter(Boolean);
		return { action: "stop", device: device.word, main: main.word, interrupt: words.includes("--interrupt"), reason: words.filter((w) => w !== "--interrupt").join(" ") };
	}
	const m = /^decide\s+(\S+)\s+(approve|refuse)$/.exec(text);
	return m ? { action: "decide", id: m[1]!, verdict: m[2] as "approve" | "refuse" } : undefined;
}

/** A box that reported its units, as the boss names it: the roster's label and short id of the device, or the start of its id when no team lists it. */
interface Box { device: string; label: string; short: string }
/** One main a box listed, with the row (team, caps, freshness) it came in. */
interface Listed { row: DeviceUnits; main: NonNullable<DeviceUnits["mains"]>[number] }

/** A typed folder against the session's own: `~` is home, a relative path starts at the session's folder. */
export function folderOf(typed: string, cwd: string): string {
	const home = homedir(), expanded = typed === "~" ? home : /^~[\\/]/.test(typed) ? resolve(home, typed.slice(2)) : typed;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export interface OpenDeps {
	/** The server's recorded GUI, or the refusal in the boss's words. */
	record(): Promise<GuiRecord>;
	post: Post;
	why(reply: Reply): string;
	/** Asked on this computer only: a paired device cannot answer it (`hereOnly`). */
	confirm(title: string, body: string, here?: boolean): Promise<boolean>;
	/** Holds the pane's local-only mark while a select that only this computer may answer waits (heremark.ts). */
	here: Here;
	noScreen(): string;
	lang(): Lang;
	/** The label of a base, for naming a unit opened in it; undefined when it cannot be read. */
	baseName?(workspace: string): Promise<string | undefined>;
	/** How often an opening is asked for a trust question. */
	pollMs?: number;
	/** More lines for `link status` (bosslink.ts: the open invites, the join in progress, the confirms and questions that wait). */
	extra?(view: LinkView): string[];
}

export function createBossOpen({ s, tell }: Kit, { record, post, why, confirm, here, noScreen, lang, baseName, pollMs = POLL_MS, extra }: OpenDeps) {
	const t = () => WORDS[lang()];

	/** The trust question an opening waits on, asked in pi; the answer goes to the route the page's dialog posts to. A dismissed question stays open for the GUI or the terminal. */
	async function answerTrust(r: GuiRecord, ask: TrustPrompt, signal: AbortSignal) {
		if (!s.ui) return tell(t().trustNoScreen, "warning");
		const groups = ask.found.map((g) => `  ${g.kind} ${g.path}${g.unreadable ? ` (${t().trustUnreadable})` : ""}${g.items.length ? `: ${g.items.slice(0, SHOWN).join(", ")}${g.items.length > SHOWN || g.more ? ` (${t().trustMore(Math.max(0, g.items.length - SHOWN) + g.more)})` : ""}` : ""}`);
		const labels = t().trustChoices, picked = await s.ui.select([t().trustTitle, ask.folder, t().trustBody, t().trustFound, ...groups].join("\n"), Object.values(labels), { signal });
		const choice = Object.keys(labels).find((k) => labels[k] === picked);
		if (!choice) return;
		const reply = await post(r, "trust/answer", { id: ask.id, digest: ask.digest, choice, answerId: randomUUID().replaceAll("-", "") }, 30_000), outcome = reply.body.outcome;
		if (outcome === "accepted") return tell(t().trustAnswered);
		if (outcome === "stale") return tell(reply.body.by === "gone" ? t().trustGone : reply.body.by === "changed" ? t().trustChanged : t().trustStale, "warning");
		if (outcome === "busy") return tell(t().trustBusy, "warning");
		tell(outcome === "unknown" || reply.status === 504 || reply.status === 0 ? t().trustUnknown : why(reply), "error");
	}

	/** The boxes whose units this computer was told lately, one per device. */
	const boxesOf = (view: LinkView): Box[] => {
		const labels = new Map(view.teams.flatMap((x) => x.members.map((mem) => [mem.id, mem] as const))), seen = new Set<string>();
		return (view.units ?? []).flatMap((row) => (seen.has(row.device) ? [] : (seen.add(row.device), [{ device: row.device, label: labels.get(row.device)?.label ?? row.device.slice(0, 6), short: labels.get(row.device)?.short ?? row.device.slice(0, 6) }])));
	};
	/** A box named as typed: its exact label (any case), short id or device id; else the start of one (a label, or four or more characters of an id). Text in a message names the candidates when it is not one. */
	function pickBox(view: LinkView, query: string): Box | string {
		const all = boxesOf(view), low = query.toLowerCase(), exact = all.filter((b) => b.label.toLowerCase() === low || b.short.toLowerCase() === low || b.device === query);
		const hit = exact.length ? exact : all.filter((b) => b.label.toLowerCase().startsWith(low) || (query.length >= 4 && (b.short.toLowerCase().startsWith(low) || b.device.startsWith(query))));
		const list = (xs: Box[]) => xs.map((b) => t().candidateBox(line(b.label), line(b.short)));
		return hit.length === 1 ? hit[0]! : hit.length ? t().manyBoxes(line(query), list(hit)) : t().noBox(line(query), list(all));
	}
	/** A dispatcher's label as the roster names it, written out; undefined for this computer's own. */
	const byLabel = (row: DeviceUnits, by: string) => (row.dispatchers?.[by]?.self ? undefined : line(row.dispatchers?.[by]?.label ?? by.slice(0, 6)));
	/** `/boss link units [box]` and `/boss link stop <box> <main> [--interrupt] [reason]`: the units a box reported and the mains this computer may stop, and the page's Stop. Whatever the box or the roster wrote (labels, names, states, handles) goes through `line`: nothing a teammate wrote repaints the list or the confirm, or reaches the terminal. */
	async function units(r: GuiRecord, view: LinkView, parsed: Extract<NonNullable<ReturnType<typeof parseLink>>, { action: "units" | "stop" }>) {
		const rows = (view.units ?? []).filter((row) => row.units.length);
		if (!rows.length) return tell(t().unitsNone, "warning");
		const found = pickBox({ ...view, units: rows }, parsed.device ?? "");
		if (parsed.device !== undefined && typeof found === "string") return tell(found, "error");
		if (parsed.action === "units") {
			const lines = rows.filter((row) => !parsed.device || (found as Box).device === row.device).flatMap((row) => {
				const box = boxesOf({ ...view, units: [row] })[0]!, teamName = view.teams.find((x) => x.team === row.team)?.name ?? row.team.slice(0, 6);
				const mains = row.mains ?? [];
				return [t().unitsBox(line(box.label), line(box.short), line(teamName), row.stale === true), ...row.units.flatMap((u) => [t().unitsUnit(line(u.unit), line(u.state)), ...mains.filter((x) => x.unit === u.unit).map((x) => t().unitsMain(line(x.name), line(x.state), byLabel(row, x.by), line(x.handle.slice(0, 6)), row.waiting?.[x.handle]?.slice(0, 3).join(", ")))]), ...(!row.canStop ? [t().unitsNoStop] : [])];
			});
			return tell(lines.join("\n"));
		}
		if (typeof found === "string") return tell(found, "error");
		const box = found, name = line(box.label), named = `${name} (${line(box.short)})`;
		// A box in two teams has a row per team: the freshest row decides, as the page's card does.
		const boxRows = rows.filter((row) => row.device === box.device).sort((a, b) => b.at - a.at), listed: Listed[] = [];
		for (const row of boxRows) for (const main of row.mains ?? []) if (!listed.some((x) => x.main.handle === main.handle)) listed.push({ row, main });
		const cands = (xs: Listed[]) => xs.map((x) => t().candidateMain(line(x.main.name), line(x.main.unit), line(x.main.handle.slice(0, 6))));
		// A box that lists no `unit-stop` (a 0.60 box sends no mains either) needs an upgrade: say so before "no mains" (REL061-F001).
		if (!boxRows.some((row) => row.canStop)) return tell(t().stopNoCap(name), "error");
		if (!listed.length) return tell(t().stopNoMains(name), "error");
		const low = parsed.main.toLowerCase(), hit = listed.filter((x) => x.main.name.toLowerCase() === low || (parsed.main.length >= 4 && x.main.handle.startsWith(parsed.main)));
		if (!hit.length) return tell(t().noMain(line(parsed.main), name, cands(listed)), "error");
		if (hit.length > 1) return tell(t().manyMains(line(parsed.main), cands(hit)), "error");
		const { row, main } = hit[0]!, mode = parsed.interrupt ? "interrupt" : "quit";
		if (main.stopping) return tell(t().stopAlready(line(main.name), name), "error");
		if (!row.canStop) return tell(t().stopNoCap(name), "error");
		if (row.stale) return tell(t().stopQuiet(name), "error");
		if (!s.ui) return tell(noScreen(), "error");
		const by = byLabel(row, main.by) ?? `${line(row.dispatchers?.[main.by]?.label ?? main.by.slice(0, 6))} (${t().stopSelf})`;
		if (!(await confirm(t().stopTitle, t().stopBody(named, line(main.name), line(main.unit), by, t().stopModes[mode]!, line(parsed.reason)), true))) return tell(t().linkDeclined);
		const reply = await post(r, "link/unit-stop", { team: row.team, device: box.device, handle: main.handle, mode, reason: parsed.reason }, 30_000);
		if (reply.status !== 200) return tell(why(reply), "error");
		tell(t().stopSent(named, line(main.name), reply.body.status === "queued"));
	}

	return {
	/** `/boss open base <dir> [label] | member [dir] | main <dir> [prompt]`: the page's + Base, + Member, and + Main. The server keeps every check (a folder under home, trust, one opening at a time); this side words the answer and asks the trust question in pi. */
		async open(rest: string | undefined, cwd: string) {
			const given = parseOpen(rest);
			if (!given) return tell(t().openUsage, "error");
			const { kind, dir: typed, text } = given;
			if (kind !== "member" && !typed) return tell(t().openNeedDir(kind), "error");
			if (kind === "member" && text) return tell(t().openMemberText, "error");
			const dir = typed ? folderOf(typed, cwd) : undefined;
			if (dir && !(statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false)) return tell(t().openNoDir(dir), "error");
			const at = s.at;
			if (kind !== "base" && !at?.workspaceId) return tell(t().openNoBase, "error");
			const body: Record<string, unknown> = kind === "base" ? { dir, label: text, prompt: "" }
				: kind === "main" ? { workspace: at.workspaceId, dir, prompt: text }
				: { workspace: at.workspaceId, ...(dir ? { dir } : { tab: at.tabId }) };
			const r = await record(), deploy = `pi-${randomUUID()}`, asked = new Set<string>(), stop = new AbortController();
			const kindWord = kind === "base" ? t().kindBase : kind === "main" ? t().kindMain : t().kindMember, name = dir ?? (at?.workspaceId ? ((await baseName?.(at.workspaceId)) ?? at.workspaceId) : "");
			tell(t().opening(kindWord, name));
			const watching = (async () => {
				while (!stop.signal.aborted) {
					await new Promise((done) => setTimeout(done, pollMs));
					if (stop.signal.aborted) return;
					const asking = (await post(r, "open/progress", { id: deploy }, 10_000)).body.trust as TrustPrompt | undefined;
					if (asking && !asked.has(asking.id + asking.digest)) (asked.add(asking.id + asking.digest), await answerTrust(r, asking, stop.signal));
				}
			})();
			const reply = await post(r, `open/${kind}`, { ...body, deploy }, OPEN_MS);
			stop.abort();
			void watching;
			if (reply.status === 200) return tell(t().opened(kindWord, name, reply.body.session));
			if (reply.status === 0) return tell(t().openTimeout, "warning");
			// The page words the create step by kind: the base, a tab, or a split pane.
			const create = kind === "base" ? "createBase" : kind === "member" && !dir ? "createPane" : "createTab", failed = typeof reply.body.step === "string" ? reply.body.step : "create";
			tell(t().openFailed(t().steps[failed === "create" ? create : failed] ?? failed, why(reply)), "error");
		},

		/** `/boss link [status]`: this device's teams and the join requests waiting; `link decide <id> approve|refuse`: the page's Approve / Refuse. */
		async link(rest: string | undefined) {
			const parsed = parseLink(rest);
			if (parsed === "usage") return tell(t().stopUsage, "error");
			if (!parsed) return tell(t().linkUsage, "error");
			if (parsed.action === "stop" && Buffer.byteLength(parsed.reason) > LIMITS.stopReason) return tell(t().stopReasonLong(Buffer.byteLength(parsed.reason), LIMITS.stopReason), "error");
			const r = await record(), state = await post(r, "link/state", {}, 10_000);
			if (state.status !== 200) return tell(why(state), "error");
			const view = state.body.view as LinkView | undefined;
			if (!view) return tell(t().linkOff, "warning");
			if (parsed.action === "units" || parsed.action === "stop") return await units(r, view, parsed);
			if (parsed.action === "status") {
				const role = (x: string) => (x === "admin" ? t().linkRoleAdmin : t().linkRoleMember);
				const teams = view.teams.flatMap((x) => [t().linkTeam(x.name, role(x.self.role), x.status === "running", x.stoppedWhy ?? ""), ...x.members.map((m) => t().linkMember(m.label, m.short, role(m.role), m.attended, m.online, m.self))]);
				const requests = view.joinRequests.length ? [t().linkRequests, ...view.joinRequests.map((q) => t().linkRequest(q.id.slice(0, 8), q.label, q.short, q.teamName, q.unattended))] : [t().linkNoRequests];
				return tell([t().linkDevice(view.label, view.short), ...(teams.length ? teams : [t().linkNoTeams]), ...requests, ...(extra?.(view) ?? [])].join("\n"));
			}
			const hit = view.joinRequests.filter((q) => q.id === parsed.id || (parsed.id.length >= 4 && q.id.startsWith(parsed.id)));
			if (!hit.length) return tell(t().linkNoRequest(parsed.id), "error");
			if (hit.length > 1 && !hit.some((q) => q.id === parsed.id)) return tell(t().linkManyRequests(parsed.id), "error");
			const q = hit.find((x) => x.id === parsed.id) ?? hit[0]!;
			let sent: Record<string, unknown> = { id: q.id, approve: false };
			if (parsed.verdict === "approve") {
				if (!s.ui) return tell(noScreen(), "error");
				if (q.unattended) {
					if (!(await confirm(t().linkApproveTitle, t().linkApproveUnattended(q.label, q.short, q.teamName), true))) return tell(t().linkDeclined);
					sent = { id: q.id, approve: true };
				} else {
					const words = q.sets.map((w) => w.join(" ")), none = t().linkNone, picked = await here(async () => s.ui!.select(t().linkWords(q.label, q.short, q.teamName), [...words, none], hereOnlyOpts()));
					if (picked === undefined) return tell(t().linkDeclined);
					if (picked !== none) sent = { id: q.id, pick: words.indexOf(picked) };
				}
			}
			const reply = await post(r, "link/decide", sent, 30_000);
			if (reply.status !== 200) return tell(why(reply), "error");
			tell(reply.body.joined === true ? t().linkJoined(q.label, q.teamName) : t().linkRefused(q.label));
		},
	};
}
