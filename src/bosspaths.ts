import { existsSync } from "node:fs";
import { type GuiRecord, postServer } from "./handover.ts";
import { workspaces } from "./herdr.ts";
import { createBossAnswer } from "./bossanswer.ts";
import { createBossLink } from "./bosslink.ts";
import { createBossHold } from "./bosshold.ts";
import { createBossOpen } from "./bossopen.ts";
import type { Here } from "./heremark.ts";
import { hereOnlyOpts } from "./intercept.ts";
import type { createHost } from "./host.ts";
import { type Locale as Lang, localeOf } from "./locale.ts";
import { collectNet, type Net, type Unit } from "./net.ts";
import type { ServerLook } from "./server-look.ts";
import { newer } from "./semver.ts";
import { nameFor, nameOk, stashFile } from "./stash.ts";
import type { Kit } from "./state.ts";
import { ownerOf, todoRef } from "./planowner.ts";
import { todosOfBranch } from "./todo.ts";

// The boss's typed twins of GUI buttons that had no pi path (/boss close <name>, close all <workspace>, stash --workspace, dismiss, gui devices, gui unpair, server logs). Each posts to the
// route the page posts to (`gui.json`, as stashing.ts does), so the server keeps every permission and safety check; this side resolves a name, asks the boss to confirm anything that quits
// someone else, and words the answer. They are the boss's typed input only: boss.ts refuses them in a tower run or an ally run, and no tool reaches this module.

const CLOSE_MS = 120_000, MAX_LOG_LINES = 200;
const WORDS = {
	en: {
		none: (q: string) => `Nothing on the net is named "${q}": a unit, squad, or base is named by its name or key`,
		many: (q: string, list: string[]) => `"${q}" names more than one; nothing was done. Say which (kind:name):\n${list.join("\n")}`,
		self: "That is this session: /boss close quits it",
		noScreen: "Closing something other than this session needs the pi screen to confirm it",
		ask: "Quit it?",
		declined: "Nothing was closed",
		unit: (n: string, base: string) => `${n} (in ${base}) quits and its pane closes.`,
		squad: (n: string, base: string, names: string[]) => `The squad ${n} (in ${base}) quits${names.length ? `: ${names.join(", ")}` : ""}, then the tab closes.`,
		base: (n: string, names: string[]) => `The whole base ${n} quits${names.length ? `: ${names.join(", ")}` : ""}, then the workspace closes (the server checks first that nothing would be lost).`,
		stashOther: (n: string) => `The base ${n} is put away: its tower, mains, and members quit and the workspace closes.`,
		closing: (n: string) => `Closing ${n}…`,
		stashed: (n: string, name: string, k: unknown) => `Stashed ${n} as "${name}" (${String(k)} sessions); /boss pop ${name} brings it back`,
		stashing: (n: string, name: string) => `Stashing ${n} as "${name}"…`,
		noBase: (q: string) => `No workspace is labeled or has the id "${q}"`,
		manyBases: (q: string, list: string[]) => `"${q}" names more than one workspace; nothing was done:\n${list.join("\n")}`,
		badName: (n: string) => `"${n}" cannot name a stash: at most 64 characters, no slash, backslash, or control character, not starting with a dot`,
		taken: (n: string) => `Something is stashed as "${n}" already; pop it or pick another name`,
		noSub: (q: string) => `No finished subagent is named "${q}"`,
		manySubs: (q: string, list: string[]) => `"${q}" names more than one finished subagent; nothing was done:\n${list.join("\n")}`,
		dismissed: (n: unknown) => `Dismissed ${String(n)} finished subagent${n === 1 ? "" : "s"}`,
		dismissedOne: (n: string) => `Dismissed ${n}`,
		noDevices: "No device is paired",
		devices: (on: boolean) => `Paired devices (Tailscale access is ${on ? "on" : "off"}):`,
		never: "never",
		noDevice: (q: string) => `No paired device has the id "${q}": /boss gui devices lists them`,
		manyDevices: (q: string) => `More than one paired device starts with "${q}"; give more of the id`,
		unpairAsk: "Unpair every device?",
		unpairAskBody: "Every paired phone, on Tailscale and on Wi-Fi, is unpaired and pairs again with a QR code or the pairing code. The address does not change.",
		unpairedAll: (n: unknown) => `Unpaired ${String(n)} device${n === 1 ? "" : "s"}`,
		unpaired: (n: string) => `Unpaired ${n}`,
		needWorkspace: "stash --workspace needs a label or id: stash [name] --workspace <label|id>",
		noSend: "Nothing was sent: name the session and the words: /boss send <name|key> [--after] <text> (quote a name that has spaces: /boss send \"fix login\" <text>)",
		noStop: "Nothing was stopped: name the session: /boss stop <name|key> (quote a name that has spaces: /boss stop \"fix login\")",
		oldServer: (have: string | undefined, need: string) => `Nothing was sent: the sb server runs pi-straw-boss ${have ?? "(unknown)"}, which does not hold /boss send to a remote write's guards. Restart it on pi-straw-boss ${need} or newer (/boss server restart).`,
		sendSelf: "That is this session: type it here instead",
		noTodo: (q: string) => `This session's todo list has no ${q}`,
		noOwner: (q: string, owner?: string) => (owner ? `The owner of ${q}, "${owner}", is not on the net: nothing was sent` : `${q} names no owner: nothing was sent`),
		ownerGone: (q: string, owner: string) => `The owner of ${q}, "${owner}", has left the net: nothing was sent`,
		sent: (n: string, after: boolean) => `Sent to ${n}${after ? " as a follow-up" : ""}`,
		notSent: "Nothing was sent",
		confirmSend: "Send it?", confirmSendBody: (n: string, text: string) => `${n} would end or replace its session with this: ${text}`,
		stopAsk: "Stop it?", stopBody: (n: string) => `${n} stops its current task; the messages queued for it go back to its terminal editor.`,
		notStopped: "Nothing was stopped",
		noScreenStop: "Stopping another session needs the pi screen to confirm it",
		escSent: (n: string) => `Sent Esc to ${n}`,
		noLines: "Ask for 1 to 200 lines",
		emptyLog: "(the log is empty)",
		noAnswer: "the GUI server did not answer",
		stopped: "The straw net GUI was stopped on purpose; /boss gui starts it, then run this again",
		notRunning: (why: string) => `The straw net GUI is not running: ${why}`,
		answered: (n: number) => `the server answered ${n}`,
	},
	"zh-TW": {
		none: (q: string) => `網路上沒有名為「${q}」的單位、小隊或基地：用名稱或 key 指定`,
		many: (q: string, list: string[]) => `「${q}」對到不只一個，什麼都沒做。請指明（種類:名稱）：\n${list.join("\n")}`,
		self: "這就是目前的工作階段：用 /boss close 結束它",
		noScreen: "結束本工作階段以外的東西，需要 pi 畫面來確認",
		ask: "要結束嗎？",
		declined: "什麼都沒有關閉",
		unit: (n: string, base: string) => `${n}（在 ${base}）會結束，它的窗格會關閉。`,
		squad: (n: string, base: string, names: string[]) => `小隊 ${n}（在 ${base}）會結束${names.length ? `：${names.join("、")}` : ""}，然後分頁關閉。`,
		base: (n: string, names: string[]) => `整個基地 ${n} 會結束${names.length ? `：${names.join("、")}` : ""}，然後工作區關閉（伺服器會先檢查沒有東西會遺失）。`,
		stashOther: (n: string) => `基地 ${n} 會收起來：它的塔台、主代理與成員結束，工作區關閉。`,
		closing: (n: string) => `正在關閉 ${n}…`,
		stashed: (n: string, name: string, k: unknown) => `已把 ${n} 收起來，名稱「${name}」（${String(k)} 個工作階段）；/boss pop ${name} 可以還原`,
		stashing: (n: string, name: string) => `正在把 ${n} 收起來，名稱「${name}」…`,
		noBase: (q: string) => `沒有標籤或 id 是「${q}」的工作區`,
		manyBases: (q: string, list: string[]) => `「${q}」對到不只一個工作區，什麼都沒做：\n${list.join("\n")}`,
		badName: (n: string) => `「${n}」不能當收納名稱：最多 64 字，不含斜線、反斜線或控制字元，也不能以點開頭`,
		taken: (n: string) => `已經有收納叫「${n}」；先還原它，或換個名稱`,
		noSub: (q: string) => `沒有名為「${q}」的已結束子智慧體`,
		manySubs: (q: string, list: string[]) => `「${q}」對到不只一個已結束的子智慧體，什麼都沒做：\n${list.join("\n")}`,
		dismissed: (n: unknown) => `已移除 ${String(n)} 個已結束的子智慧體`,
		dismissedOne: (n: string) => `已移除 ${n}`,
		noDevices: "沒有已配對的裝置",
		devices: (on: boolean) => `已配對的裝置（Tailscale 存取${on ? "開啟" : "關閉"}）：`,
		never: "從未",
		noDevice: (q: string) => `沒有 id 是「${q}」的已配對裝置：/boss gui devices 會列出`,
		manyDevices: (q: string) => `不只一個已配對裝置的 id 以「${q}」開頭；請多給幾碼`,
		unpairAsk: "要解除所有裝置的配對嗎？",
		unpairAskBody: "Tailscale 與 Wi-Fi 上每一支已配對的手機都會解除配對，之後要用 QR code 或配對碼重新配對。位址不會改變。",
		unpairedAll: (n: unknown) => `已解除 ${String(n)} 個裝置的配對`,
		unpaired: (n: string) => `已解除 ${n} 的配對`,
		needWorkspace: "stash --workspace 需要工作區的標籤或 id：stash [名稱] --workspace <標籤|id>",
		noSend: "沒有送出：請指定工作階段與內容：/boss send <名稱|key> [--after] <內容>（名稱含空白時加引號：/boss send \"fix login\" <內容>）",
		noStop: "沒有停止：請指定工作階段：/boss stop <名稱|key>（名稱含空白時加引號：/boss stop \"fix login\"）",
		oldServer: (have: string | undefined, need: string) => `沒有送出：sb server 是 pi-straw-boss ${have ?? "（未知）"}，不會讓 /boss send 受遠端寫入的防護約束。請重啟成 pi-straw-boss ${need} 以上（/boss server restart）。`,
		sendSelf: "這就是目前的工作階段：直接在這裡輸入",
		noTodo: (q: string) => `這個工作階段的待辦清單沒有 ${q}`,
		noOwner: (q: string, owner?: string) => (owner ? `${q} 的負責者「${owner}」不在網路上：沒有送出` : `${q} 沒有負責者：沒有送出`),
		ownerGone: (q: string, owner: string) => `${q} 的負責者「${owner}」已離開網路：沒有送出`,
		sent: (n: string, after: boolean) => `已送給 ${n}${after ? "（排在目前工作之後）" : ""}`,
		notSent: "沒有送出",
		confirmSend: "要送出嗎？", confirmSendBody: (n: string, text: string) => `${n} 會因為這段話結束或換掉它的工作階段：${text}`,
		stopAsk: "要停止嗎？", stopBody: (n: string) => `${n} 會停止目前的任務；排在它後面的訊息會退回它的終端機編輯器。`,
		notStopped: "沒有停止",
		noScreenStop: "停止別的工作階段需要 pi 畫面來確認",
		escSent: (n: string) => `已對 ${n} 送出 Esc`,
		noLines: "請給 1 到 200 行",
		emptyLog: "（記錄是空的）",
		noAnswer: "GUI 伺服器沒有回應",
		stopped: "straw net GUI 是刻意停掉的；先用 /boss gui 啟動它，再重新執行",
		notRunning: (why: string) => `straw net GUI 沒有在執行：${why}`,
		answered: (n: number) => `伺服器回應 ${n}`,
	},
} as const;

type Kind = "unit" | "squad" | "base";
interface Target { kind: Kind; key: string; workspace: string; tab?: string; name: string; base: string; members: string[] }
type Reply = { status: number; body: Record<string, unknown> };
export type Post = (record: GuiRecord, path: string, json: Record<string, unknown>, timeoutMs: number) => Promise<Reply>;

/** `/boss stash [name] [--workspace <label|id>]`: the name before the flag and the workspace after it, both as typed. */
export function parseStash(rest: string | undefined): { name?: string; workspace?: string; flag?: true } {
	const text = (rest ?? "").trim(), at = /(^|\s)--workspace(?:\s+|=|$)(.*)$/.exec(text);
	if (!at) return text ? { name: text } : {};
	const name = text.slice(0, at.index).trim(), workspace = at[2]!.trim();
	return { ...(name ? { name } : {}), ...(workspace ? { workspace } : { flag: true as const }) };
}

const flat = (units: Unit[]): Unit[] => units.flatMap((u) => [u, ...flat(u.subs)]);

/** The first pi-straw-boss whose server reads `guarded` on a session's input. */
const GUARDED_SINCE = "0.61.0";
export function createBossPaths(kit: Kit, { host, server, closeSelf, post = postServer, read, pollMs, here, stream }: { host: Pick<ReturnType<typeof createHost>, "ensure" | "sessions">; /** Holds the pane's local-only mark while a screen that only this computer may answer waits (heremark.ts). */ here: Here; server?: Pick<ServerLook, "logs">; closeSelf(keepPane: boolean): string | undefined; post?: Post; /** The net as the boss sees it; tests hand one over. */ read?: () => Promise<Net>; /** How often an opening is asked for a trust question (bossopen.ts). */ pollMs?: number; /** The net as the page's stream sends it, with each waiting unit's answerable dialog (`/boss answer`); tests hand one over. */ stream?: (r: GuiRecord) => Promise<Net> }) {
	const { cfg, s, guiDir, tell, me } = kit, lang = (): Lang => localeOf(cfg.env, guiDir), t = () => WORDS[lang()];
	const net = (): Promise<Net> => read ? read() : collectNet({ run: cfg.run, world: cfg.world, sessions: () => host.sessions() });
	/** The server's recorded GUI; a refusal says why in the boss's words. */
	async function record(): Promise<GuiRecord> {
		const shared = await host.ensure();
		if (shared.stopped) throw new Error(t().stopped);
		if (!shared.record) throw new Error(t().notRunning(shared.error ?? ""));
		return shared.record;
	}
	const why = (r: Reply) => (typeof r.body.reason === "string" ? r.body.reason : r.status ? t().answered(r.status) : t().noAnswer);
	const confirm = async (title: string, body: string, local = false) => (local ? await here(async () => s.ui?.confirm(title, body, hereOnlyOpts())) : await s.ui?.confirm(title, body)) === true;

	/** Every unit (tower, mains, members), squad, and base of the net, as something `/boss close` can name. */
	function targets(n: Net): Target[] {
		const out: Target[] = [];
		for (const b of n.bases) {
			const members = (tab: { units: Unit[] }) => tab.units.filter((u) => u.role !== "subagent").map((u) => u.name);
			if (b.tower) out.push({ kind: "unit", key: b.tower.key, workspace: b.id, name: b.tower.name, base: b.label, members: [] });
			for (const tab of b.tabs) {
				out.push({ kind: "squad", key: `${b.id}/${tab.id}`, workspace: b.id, tab: tab.id, name: tab.label, base: b.label, members: members(tab) });
				for (const u of tab.units) if (u.role === "main" || u.role === "member") out.push({ kind: "unit", key: u.key, workspace: b.id, name: u.name, base: b.label, members: [] });
			}
			out.push({ kind: "base", key: b.id, workspace: b.id, name: b.label, base: b.label, members: [...(b.tower ? [b.tower.name] : []), ...b.tabs.flatMap(members)] });
		}
		return out;
	}
	const label = (x: Target) => `  ${x.kind}:${x.name}${x.kind === "base" ? "" : ` (in ${x.base})`} [${x.kind === "unit" ? x.key : x.workspace}]`;
	/** `kind:name` narrows to one kind; a name or a key (or its start, from six characters) picks. */
	function pick(all: Target[], query: string): Target | string {
		const m = /^(unit|squad|base):(.+)$/.exec(query), kind = m?.[1], q = (m?.[2] ?? query).trim(), low = q.toLowerCase();
		// A name Herdr's row cut (`sb_name`, 23 characters and `…`) picks the one full name it begins.
		const cut = q.length > 1 && q.endsWith("…") ? low.slice(0, -1) : undefined;
		const hit = all.filter((x) => (!kind || x.kind === kind) && (x.name.toLowerCase() === low || (cut !== undefined && x.name.length > cut.length && x.name.toLowerCase().startsWith(cut)) || x.key === q || (q.length >= 6 && x.key.startsWith(q)) || (x.kind === "base" && x.workspace === q)));
		return hit.length === 1 ? hit[0]! : hit.length ? t().many(query, hit.map(label)) : t().none(query);
	}

	/** Every unit the page's composer reaches: the tower, mains, members, and subagents. */
	function sendables(n: Net): Target[] {
		const out: Target[] = [];
		for (const b of n.bases) for (const u of [...(b.tower ? [b.tower, ...flat(b.tower.subs)] : []), ...b.tabs.flatMap((tab) => flat(tab.units)), ...flat(b.outside)]) {
			if (!("role" in u) || u.role !== "outside") out.push({ kind: "unit", key: u.key, workspace: b.id, name: u.name, base: b.label, members: [] });
		}
		return out;
	}
	/** `/boss send <name|key> [--after] <text>` and `/boss stop <name|key>`: the composer's Send, After this, and Stop (the same routes, so the server keeps its guards). `post1` gets the session and the words that name it. */
	/** A todo of this session named by `#<id>` or its uid: the unit of its owner (planowner.ts: the Herdr child's run id, then its full name), or why there is none. */
	function ownerTarget(n: Net, query: string, ref: { id: number } | { uid: string }): Target | string {
		const todo = (todosOfBranch(s.branch()) ?? []).find((x) => ("id" in ref ? x.id === ref.id : x.uid === ref.uid)), named = todo?.owner ?? todo?.agent;
		if (!todo) return t().noTodo(query);
		const hit = ownerOf(n, me(), todo);
		if (hit === "gone") return t().ownerGone(query, named!);
		return sendables(n).find((x) => x.key === hit?.key) ?? t().noOwner(query, named);
	}
	async function toSession(query: string, post1: (key: string, named: string) => Promise<Reply>, said: (name: string) => string) {
		// `#63` or a todo uid names this session's todo and goes to its owner; `subagent-chat-<id>` (a child as pi-intercom lists it) is its key.
		const n = await net(), ref = todoRef(query), found = ref ? ownerTarget(n, query, ref) : pick(sendables(n), /^subagent-chat-(.+)$/.exec(query)?.[1] ?? query);
		if (typeof found === "string") return tell(found, "error");
		if (found.key === me()) return tell(t().sendSelf, "error");
		const reply = await post1(found.key, `${found.name} (in ${found.base}) [${found.key}]`);
		reply.status === 200 ? tell(said(found.name)) : tell(why(reply), "error");
	}
	const more = createBossLink(kit, { record, post, why, confirm, lang, here }), hold = createBossHold(kit, { record, post, why, confirm, lang });
	const answer = createBossAnswer(kit, { record, post, why, confirm, lang, build: more.build, ...(stream ? { net: stream } : {}) });
	const open = createBossOpen(kit, { record, post, why, confirm, here, noScreen: () => t().noScreen, lang, baseName: async (id) => (await workspaces(cfg.run).catch(() => [])).find((w) => w.workspace_id === id)?.label, pollMs, extra: more.status });

	return {
		...open,
		/** `/boss link …`: confirms, questions, invites, join, create, and leave are bosslink.ts's; status and decide are bossopen.ts's. */
		link: (rest: string | undefined, cwd = process.cwd()) => (hold.handles(rest) ? hold.run(rest!) : more.handles(rest) ? more.run(rest!, cwd) : open.link(rest)),
		/** `/boss answer [<name|key> [--cancel | <choice number | text>]]`: lists the dialogs other sessions wait on, or answers one as the page does (bossanswer.ts). */
		answer,
		/** The refusal for `/boss stash --workspace` with no value. */
		needWorkspace: () => tell(t().needWorkspace, "error"),
		/** `/boss close <name|key>` (or `close all <workspace>` with `onlyBase`): quits another unit, squad, or base after the boss confirms in pi. */
		async close(query: string, onlyBase = false) {
			const found = pick((targets(await net())).filter((x) => !onlyBase || x.kind === "base"), onlyBase ? `base:${query}` : query);
			if (typeof found === "string") return tell(found, "error");
			if (found.kind === "unit" && found.key === me()) return void ((r) => r && tell(r, "error"))(closeSelf(false));
			if (!s.ui) return tell(t().noScreen, "error");
			const body = found.kind === "unit" ? t().unit(found.name, found.base) : found.kind === "squad" ? t().squad(found.name, found.base, found.members) : t().base(found.name, found.members);
			if (!(await confirm(t().ask, body))) return tell(t().declined);
			const r = await record();
			tell(t().closing(found.name));
			const reply = found.kind === "unit" ? await post(r, "close/unit", { key: found.key }, CLOSE_MS) : found.kind === "squad" ? await post(r, "close/tab", { workspace: found.workspace, tab: found.tab }, CLOSE_MS) : await post(r, "close/all", { workspace: found.workspace }, CLOSE_MS * 4);
			if (reply.status === 200) return; // "Closing" was said; the server answers once the quit is accepted, not when the pane is gone
			// A unit that is closing leaves the net at once; a base's server may have closed with its own base.
			if (reply.status === 0 && found.kind === "base") return tell(t().noAnswer, "warning");
			tell(why(reply), "error");
		},

		/** `/boss stash [name] --workspace <label|id>`: puts another base away. This session's own base stays `stashing.stash`. */
		async stashOther(given: string | undefined, query: string) {
			const all = await workspaces(cfg.run), low = query.toLowerCase();
			const hit = all.filter((w) => w.workspace_id === query || w.label.toLowerCase() === low);
			if (!hit.length) return tell(t().noBase(query), "error");
			if (hit.length > 1) return tell(t().manyBases(query, hit.map((w) => `  ${w.label} [${w.workspace_id}]`)), "error");
			const ws = hit[0]!, name = given?.trim() || nameFor(ws.label, guiDir);
			if (!nameOk(name)) return tell(t().badName(name), "error");
			if (existsSync(stashFile(guiDir, name))) return tell(t().taken(name), "error");
			if (!s.ui) return tell(t().noScreen, "error");
			if (!(await confirm(t().ask, t().stashOther(ws.label)))) return tell(t().declined);
			const r = await record();
			tell(t().stashing(ws.label, name));
			const reply = await post(r, "close/stash", { workspace: ws.workspace_id, name }, CLOSE_MS);
			if (reply.status === 200) return tell(t().stashed(ws.label, name, reply.body.sessions));
			tell(why(reply), "error");
		},

		/** `/boss dismiss [all|<name>]`: hides finished subagents from the net, as the page's Dismiss does. */
		async dismiss(what: string | undefined) {
			const q = what?.trim() ?? "";
			if (!q || q === "all") {
				const reply = await post(await record(), "dismiss", { all: true }, 10_000);
				return reply.status === 200 ? tell(t().dismissed(reply.body.dismissed)) : tell(why(reply), "error");
			}
			const subs = (await net()).bases.flatMap((b) => [...(b.tower ? flat(b.tower.subs) : []), ...b.tabs.flatMap((tab) => flat(tab.units)), ...flat(b.outside)]).filter((u) => u.role === "subagent" && u.ended);
			const hit = subs.filter((u) => u.name.toLowerCase() === q.toLowerCase() || u.key === q);
			if (!hit.length) return tell(t().noSub(q), "error");
			if (hit.length > 1) return tell(t().manySubs(q, hit.map((u) => `  ${u.name} [${u.key}]`)), "error");
			const reply = await post(await record(), "dismiss", { key: hit[0]!.key }, 10_000);
			reply.status === 200 ? tell(t().dismissedOne(hit[0]!.name)) : tell(why(reply), "error");
		},

		/** `/boss send <name|key> [--after] <text>`: as the composer's Send (idle: submit, working: steer) or After this (a follow-up). The post says `guarded`: it comes from this computer, but a paired device may have typed the command, so the server holds it to the guards a paired device meets. A command that ends the session asks first, as the page does. */
		async send(query: string, after: boolean, text: string) {
			if (!query || !text.trim()) return tell(t().noSend, "error");
			const as = after ? "followUp" : "send";
			await toSession(query, async (key, named) => {
				const r = await record(), body = { text, as, guarded: true };
				// A server that predates the flag would type the text as a plain local write, the bypass `guarded` closes.
				if (newer(GUARDED_SINCE, r.version)) return { status: 0, body: { reason: t().oldServer(r.version, GUARDED_SINCE) } };
				const first = await post(r, `sessions/${encodeURIComponent(key)}/input`, body, 30_000);
				if (first.status !== 409 || first.body.error !== "confirm") return first;
				if (!s.ui || !(await confirm(t().confirmSend, t().confirmSendBody(named, text.slice(0, 200))))) return { status: 0, body: { reason: t().notSent } };
				return post(r, `sessions/${encodeURIComponent(key)}/input`, { ...body, confirmed: true }, 30_000);
			}, (name) => t().sent(name, after));
		},

		/** `/boss stop <name|key>`: the page's Stop, an Esc into that session's editor, after the same question. */
		async stop(query: string) {
			if (!query) return tell(t().noStop, "error");
			await toSession(query, async (key, named) => {
				if (!s.ui) return { status: 0, body: { reason: t().noScreenStop } };
				if (!(await confirm(t().stopAsk, t().stopBody(named)))) return { status: 0, body: { reason: t().notStopped } };
				return post(await record(), `sessions/${encodeURIComponent(key)}/keys`, { keys: ["esc"] }, 30_000);
			}, t().escSent);
		},

		/** `/boss gui devices`: the paired devices, newest pairing last as the server lists them. */
		async devices() {
			const reply = await post(await record(), "remote/devices", {}, 10_000);
			if (reply.status !== 200) return tell(why(reply), "error");
			const list = (reply.body.devices ?? []) as { id: string; label: string; paired: number; seen: number; net: "tailnet" | "lan"; host?: string }[];
			const when = (ms: number) => (ms > 0 ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC` : t().never);
			tell(list.length ? [t().devices(reply.body.on === true), ...list.map((d) => `  ${d.id}  ${d.label || "?"}  ${d.net === "lan" ? "Wi-Fi" : "Tailscale"}  paired ${when(d.paired)}  last seen ${when(d.seen)}`)].join("\n") : t().noDevices);
		},

		/** `/boss gui unpair <id|all>`: the page's Unpair; the address does not change. */
		async unpair(which: string) {
			if (which === "all") {
				if (!s.ui) return tell(t().noScreen, "error");
				if (!(await confirm(t().unpairAsk, t().unpairAskBody, true))) return tell(t().declined);
				const reply = await post(await record(), "remote/unpair-all", {}, 10_000);
				return reply.status === 200 ? tell(t().unpairedAll(reply.body.unpaired)) : tell(why(reply), "error");
			}
			const r = await record(), listed = await post(r, "remote/devices", {}, 10_000);
			if (listed.status !== 200) return tell(why(listed), "error");
			const ids = ((listed.body.devices ?? []) as { id: string }[]).map((d) => d.id), hit = ids.includes(which) ? [which] : ids.filter((id) => id.startsWith(which));
			if (!hit.length) return tell(t().noDevice(which), "error");
			if (hit.length > 1) return tell(t().manyDevices(which), "error");
			const reply = await post(r, "remote/unpair", { id: hit[0]! }, 10_000);
			reply.status === 200 ? tell(t().unpaired(hit[0]!)) : tell(why(reply), "error");
		},

		/** `/boss server logs [n]`: the last lines of the server's log, as `boss_server logs` returns them. */
		async logs(count: string | undefined) {
			const n = count === undefined ? MAX_LOG_LINES : /^\d+$/.test(count) ? Number(count) : 0;
			if (n < 1 || n > MAX_LOG_LINES) return tell(t().noLines, "error");
			if (!server) return tell("The sb server is not available in this session.", "warning");
			tell((await server.logs(n)).join("\n") || t().emptyLog);
		},
	};
}
