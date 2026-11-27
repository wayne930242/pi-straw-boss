import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ASK_ROWS_EVENT, type AskRowV1 } from "./asktypes.ts";
import { localeOf, type Locale } from "./locale.ts";
import type { Kit } from "./state.ts";
import { todosOfBranch } from "./todo.ts";
import { callServer, type ServerCall } from "./traincar.ts";

// A session's rows of the open questions to the boss (docs/specs/2026-11-28-boss-asks.md, The probe): it asks the sb server every 15 s (`asks-rows`), answers `straw-boss:ask-rows:v1` from the last answer at once (the
// probe is synchronous), and prints the same rows for `/boss asks`. The rows are every open Ask of this computer; `mine` and `item` let the reader put a row under the todo it blocks.

/** Between two asks of the server; the probe's rows stand for what waits now only this long after the server's last answer (three asks), then the probe answers none (asks-r2-F007). */
export const ASK_MS = 15_000, STALE_MS = 45_000;
export interface AskRowsDeps {
	pi: Pick<ExtensionAPI, "on" | "events">;
	me(): string;
	/** This session has an sb server to ask (no subagent, a pane). */
	enabled(): boolean;
	call: ServerCall;
	/** The session's branch, for its todo list (the subject of the todo a row blocks). */
	branch(): readonly unknown[];
	lang(): Locale;
	now(): number;
	/** Between two asks of the server; 0 asks only on `refresh` (tests). */
	every?: number;
}
/** `42s`, `12m`, `1h05m`, `3d4h`, as the run and car rows have it. */
export const since = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60); return s < 60 ? `${s}s` : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`; };
const valid = (r: AskRowV1) => typeof r?.id === "string" && typeof r.subject === "string" && typeof r.kind === "string" && Number.isFinite(r.since);
const WORDS = {
	en: { none: "No question waits on you.", head: (n: number) => `Questions waiting on you (${n}):`, mine: "From this session and its subagents:", others: "Elsewhere on this computer:", blocks: (t: string) => `blocks ${t}`, off: "The sb server did not answer, so the questions are not known here; /boss server shows it." },
	"zh-TW": { none: "沒有在等你回答的問題。", head: (n: number) => `等你回答的問題（${n}）：`, mine: "這個 session 和它的子代理：", others: "這台電腦的其他地方：", blocks: (t: string) => `卡住 ${t}`, off: "sb server 沒有回應，這裡看不到在等你的問題；/boss server 可看它的狀態。" },
} as const;

export function registerAskRows(d: AskRowsDeps) {
	const every = d.every ?? ASK_MS;
	let rows: AskRowV1[] = [], answered: number | undefined, fresh = false, timer: ReturnType<typeof setInterval> | undefined, running: Promise<void> | undefined;
	/** `fresh`: the last ask was answered; a failed one keeps the rows for the probe until they are `STALE_MS` old, and `/boss asks` says the server did not answer. */
	async function look(): Promise<void> {
		if (!d.enabled() || !d.me()) return;
		const reply = await d.call({ cmd: "asks-rows", session: d.me() }).catch(() => undefined);
		fresh = Boolean(reply?.ok && Array.isArray(reply.rows));
		if (!fresh) return;
		rows = (reply!.rows as AskRowV1[]).filter(valid);
		answered = d.now();
	}
	const current = () => (answered !== undefined && d.now() - answered <= STALE_MS ? rows : []);
	const refresh = () => (running ??= look().finally(() => { running = undefined; }));
	d.pi.events.on(ASK_ROWS_EVENT, (raw) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
		Object.assign(raw, { rows: { version: 1, rows: current().map((r) => ({ ...r })) } });
	});
	if (every > 0) {
		d.pi.on("session_start", () => {
			if (timer) clearInterval(timer);
			void refresh();
			timer = setInterval(() => void refresh(), every);
			timer.unref?.();
		});
		d.pi.on("session_shutdown", () => { if (timer) clearInterval(timer); timer = undefined; });
	}
	/** `/boss asks`: asks the server first, so the text is the newest. */
	async function text(): Promise<string> {
		await refresh();
		const w = WORDS[d.lang()], now = d.now();
		if (!fresh) return w.off;
		if (!rows.length) return w.none;
		const todos = (() => { try { return todosOfBranch(d.branch()) ?? []; } catch { return []; } })();
		const line = (r: AskRowV1) => {
			const todo = r.item && r.item.session === d.me() ? todos.find((t) => t.id === r.item!.id) : undefined, blocks = r.item ? w.blocks(todo ? `#${todo.id} ${todo.subject}` : `#${r.item.id}`) : "";
			return `  ${[r.id, since(now - r.since), r.asker, r.where !== r.asker ? r.where : "", r.subject].filter(Boolean).join(" · ")}${blocks ? `  — ${blocks}` : ""}`;
		};
		const mine = rows.filter((r) => r.mine), rest = rows.filter((r) => !r.mine);
		return [w.head(rows.length), ...(mine.length ? [w.mine, ...mine.map(line)] : []), ...(rest.length ? [w.others, ...rest.map(line)] : [])].join("\n");
	}
	return { refresh, rows: () => rows, text, answered: () => answered };
}
export type AskRows = ReturnType<typeof registerAskRows>;

/** The ask rows of a session in a pane, wired to its kit: the server it already talks to, its branch, sb's language (read at most every 30 s: the probe is asked at every draw). */
export function askRowsOf(kit: Kit): AskRows {
	const { pi, cfg } = kit;
	let lang: { at: number; value: Locale } | undefined;
	return registerAskRows({
		pi, me: kit.me, enabled: () => !kit.s.isTower && Boolean(cfg.server) && Boolean(cfg.env.HERDR_PANE_ID) && !cfg.env.PI_SUBAGENT_ID, call: cfg.server ? callServer(cfg.env, kit.guiDir) : async () => undefined, branch: () => kit.s.branch(), now: cfg.now,
		lang: () => (lang && cfg.now() - lang.at < 30_000 ? lang.value : (lang = { at: cfg.now(), value: localeOf(cfg.env, kit.guiDir) }).value),
	});
}
