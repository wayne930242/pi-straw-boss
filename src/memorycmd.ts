// `/boss memory` (docs/specs/2026-10-26-sb-backend.md, Tower memory): the boss's pi interface to the tower's memory, first among equals; the GUI panel mirrors it and adds nothing of its own. Every operation (list,
// confirm or reject a run's proposal, add, edit, delete, resolve a wait) is one request to the sb server's `tower-memory` command, which runs the very function the GUI's POST route runs (towermemory.ts
// `memoryRequest`): the same refusals, the same rev check (each write names the rev this command has just read). A slash command is typed by the boss and nothing else reaches it: no tool of a run exposes it,
// and the server refuses `tower-memory` to a run token. Its own words come in English and Traditional Chinese (the page has Paraglide; a pi session has this table); the server's refusals stay as it wrote them.

import { clean } from "./board.ts";
import { HEAD_KEY } from "./headkey.ts";
import type { Locale } from "./locale.ts";

/** sb's language (src/locale.ts `localeOf`: the `locale` setting, else the environment). */
export type Lang = Locale;

type Id = { id: string };
export type MemoryArgs =
	| { op: "list" } | ({ op: "confirm" | "reject" } & Id) | { op: "add"; kind: "standing" | "decision"; text: string }
	| ({ op: "edit"; text: string } & Id) | ({ op: "delete" } & Id) | ({ op: "resolve"; outcome?: string } & Id)
	// The acts on a wait card (docs/specs/2026-11-07-wait-cards.md, The press); `choose` takes the option's number as the list shows it, from 1.
	| ({ op: "done" } & Id) | ({ op: "choose"; option: number } & Id) | ({ op: "decline"; reason?: string } & Id) | ({ op: "restate" } & Id);
/** The command's arguments after `memory`: an optional `-w <workspace id or label>`, then the operation. `usage` when they are not one. */
export function parseMemoryArgs(input: string): ({ workspace?: string } & MemoryArgs) | { usage: true } {
	const usage = { usage: true as const };
	let rest = input.trim(), workspace: string | undefined;
	if (/^-w(\s|$)/.test(rest)) {
		const w = /^-w\s+(\S+)\s*/.exec(rest);
		if (!w) return usage;
		workspace = w[1];
		rest = rest.slice(w[0].length);
	}
	const found = (op: MemoryArgs) => ({ ...(workspace ? { workspace } : {}), ...op });
	const id = (x: string | undefined) => x!.toUpperCase();
	let m: RegExpExecArray | null;
	if (rest === "" || rest === "list") return found({ op: "list" });
	if ((m = /^(confirm|reject)\s+(P\d+)$/i.exec(rest))) return found({ op: m[1]!.toLowerCase() as "confirm" | "reject", id: id(m[2]) });
	if ((m = /^add\s+(standing|decision)\s+(\S[\s\S]*)$/i.exec(rest))) return found({ op: "add", kind: m[1]!.toLowerCase() as "standing" | "decision", text: m[2]!.trim() });
	if ((m = /^edit\s+([SDW]\d+)\s+(\S[\s\S]*)$/i.exec(rest))) return found({ op: "edit", id: id(m[1]), text: m[2]!.trim() });
	if ((m = /^delete\s+([SDW]\d+)$/i.exec(rest))) return found({ op: "delete", id: id(m[1]) });
	if ((m = /^resolve\s+(W\d+)(?:\s+(\S[\s\S]*))?$/i.exec(rest))) return found({ op: "resolve", id: id(m[1]), ...(m[2] ? { outcome: m[2].trim() } : {}) });
	if ((m = /^done\s+(W\d+)$/i.exec(rest))) return found({ op: "done", id: id(m[1]) });
	if ((m = /^choose\s+(W\d+)\s+([1-9]\d*)$/i.exec(rest))) return found({ op: "choose", id: id(m[1]), option: Number(m[2]) });
	if ((m = /^decline\s+(W\d+)(?:\s+(\S[\s\S]*))?$/i.exec(rest))) return found({ op: "decline", id: id(m[1]), ...(m[2] ? { reason: m[2].trim() } : {}) });
	if ((m = /^restate\s+(W\d+)$/i.exec(rest))) return found({ op: "restate", id: id(m[1]) });
	return usage;
}

/** A raiser as a card names it: `tab` and `workspace` are what `/boss wait`'s switch-to row focuses. */
export interface ViewFrom { name: string; id?: string; role?: string; workspace?: string; tab?: string; gone?: true }
export interface ViewCard { type: string; lang?: string; happened?: string; do: string; url?: string; command?: string; after?: string; options?: { label: string; then: string }[]; secret?: { name: string }; from?: ViewFrom }
export interface ViewEntry { id: string; kind: "standing" | "decision" | "wait"; text: string; at?: string; for?: "boss" | "agent"; on?: string; state?: string; answered?: string; outcome?: string; card?: ViewCard; press?: { act: string; option?: number; reason?: string; at?: string; secretAsked?: string }; parked?: true }
export interface View {
	rev: number;
	entries: ViewEntry[];
	proposals: { id: string; op: "add" | "retire"; kind: "standing" | "decision"; text: string; target?: string; cites?: string }[];
}
const KIND = { en: { standing: "standing", decision: "decision" }, "zh-TW": { standing: "常駐指示", decision: "決定" } } as const;
const WORDS = {
	en: {
		usage: "Usage: /boss memory [-w workspace] [list | confirm P1 | reject P1 | add standing|decision <text> | edit S1 <text> | delete D1 | resolve W1 [outcome] | done W1 | choose W1 <n> | decline W1 [reason] | restate W1]",
		noWorkspace: "This session is not in a Herdr workspace: name one with -w <workspace id or label>.",
		noMatch: (q: string, all: string) => `No workspace matches "${q}". Workspaces: ${all}`,
		noTower: (ws: string, why: string) => `No tower memory for ${ws}: ${why}`,
		noProposal: (id: string) => `No such proposal ${id}: /boss memory shows the ones that wait`,
		noUi: "/boss memory changes the memory only in a pi session with a screen (a person at the keyboard): this one has none, so only the list is allowed.",
		head: (ws: string, n: number[]) => `Memory (${ws}): ${n[0]} standing · ${n[1]} decisions · ${n[2]} waits${n[3] ? ` · ${n[3]} proposals to confirm` : ""}`,
		none: "Nothing is kept.",
		proposals: (id: string, ws: string) => `Proposals from the tower for ${ws} (/boss memory confirm ${id} · reject ${id}):`,
		propAdd: (id: string, kind: string, text: string) => `${id} add ${kind}: ${text}`,
		propRetire: (id: string, target: string | undefined, text: string) => `${id} retire ${target}: ${text}`,
		cites: (text: string) => `    from your message: ${text}`,
		standing: "Standing instructions:", decisions: "Decisions (newest first):", waits: "Waits:",
		forBoss: "for you", forAgent: (who: string) => `for ${who}`, state: (s?: string, outcome?: string, boss?: boolean) => (s === "answered" ? (boss ? " (you answered it; the tower has not resolved it yet)" : " (answered?)") : s === "resolved" ? ` (resolved${outcome ? `: ${outcome}` : ""})` : s === "expired" ? " (expired)" : ""),
		confirmedAdd: (p: string, ws: string, id: string, text: string) => `${p} confirmed (${ws}): ${id} kept: ${text}`,
		confirmedRetire: (p: string, ws: string, id: string | undefined, text: string) => `${p} confirmed (${ws}): ${id} retired: ${text}`,
		rejected: (p: string, ws: string, text: string) => `${p} rejected (${ws}): ${text}`, kept: (id: string, text: string) => `${id} kept: ${text}`, edited: (id: string) => `${id} edited.`, deleted: (id: string) => `${id} deleted.`, resolved: (id: string) => `${id} resolved.`,
		where: "where", run: "run", after: "after", secretName: "secret",
		pressed: (id: string, what: string, note: string) => `${id} ${what}${note ? `: ${note}` : "."}`,
		didDone: "done", didChose: (label: string) => `chose "${label}"`, didDecline: "declined", didRestate: "asked the tower to record it again",
		told: (name: string) => `${name} was told.`, notReached: (name: string, status: string) => `${name} was not reached (${status}): tell it yourself.`,
		noOption: (id: string, n: number) => `${id} has no option ${n}`,
	},
	"zh-TW": {
		usage: "用法：/boss memory [-w workspace] [list | confirm P1 | reject P1 | add standing|decision <內容> | edit S1 <內容> | delete D1 | resolve W1 [結果] | done W1 | choose W1 <第幾個> | decline W1 [原因] | restate W1]",
		noWorkspace: "這個 session 不在任何 Herdr workspace 裡：用 -w <workspace id 或名稱> 指定。",
		noMatch: (q: string, all: string) => `沒有符合「${q}」的 workspace。現有：${all}`,
		noTower: (ws: string, why: string) => `${ws} 沒有塔台記憶可用：${why}`,
		noProposal: (id: string) => `沒有這則提議 ${id}：/boss memory 會列出等你確認的`,
		noUi: "/boss memory 只在有畫面的 pi session（有人在鍵盤前）裡改記憶：這個 session 沒有畫面，只能看清單。",
		head: (ws: string, n: number[]) => `記憶（${ws}）：${n[0]} 常駐指示・${n[1]} 決定・${n[2]} 等待${n[3] ? `・${n[3]} 則待你確認` : ""}`,
		none: "沒有保存任何內容。",
		proposals: (id: string, ws: string) => `${ws} 的塔台提議（/boss memory confirm ${id}・reject ${id}）：`,
		propAdd: (id: string, kind: string, text: string) => `${id} 新增${kind}：${text}`,
		propRetire: (id: string, target: string | undefined, text: string) => `${id} 撤掉 ${target}：${text}`,
		cites: (text: string) => `    你的訊息：${text}`,
		standing: "常駐指示：", decisions: "決定（新到舊）：", waits: "等待：",
		forBoss: "等你", forAgent: (who: string) => `等 ${who}`, state: (s?: string, outcome?: string, boss?: boolean) => (s === "answered" ? (boss ? "（你已回覆，塔台還沒結案）" : "（可能已回覆）") : s === "resolved" ? `（已處理${outcome ? `：${outcome}` : ""}）` : s === "expired" ? "（已失效）" : ""),
		confirmedAdd: (p: string, ws: string, id: string, text: string) => `${p} 已確認（${ws}）：${id} 已保存：${text}`,
		confirmedRetire: (p: string, ws: string, id: string | undefined, text: string) => `${p} 已確認（${ws}）：${id} 已撤掉：${text}`,
		rejected: (p: string, ws: string, text: string) => `${p} 已駁回（${ws}）：${text}`, kept: (id: string, text: string) => `${id} 已保存：${text}`, edited: (id: string) => `${id} 已改。`, deleted: (id: string) => `${id} 已刪。`, resolved: (id: string) => `${id} 已處理。`,
		where: "在哪裡", run: "指令", after: "做完之後", secretName: "密鑰",
		pressed: (id: string, what: string, note: string) => `${id} 已按下：${what}${note ? `。${note}` : "。"}`,
		didDone: "我做完了", didChose: (label: string) => `選了「${label}」`, didDecline: "略過", didRestate: "請塔台重寫成卡片",
		told: (name: string) => `已通知 ${name}。`, notReached: (name: string, status: string) => `沒通知到 ${name}（${status}）：請自己告訴它。`,
		noOption: (id: string, n: number) => `${id} 沒有第 ${n} 個選項`,
	},
};

/** The words of `/boss memory` in a language, for the commands that press a card the same way (waitcmd.ts): the result line of a press, and who was told. */
export const memoryWords = (lang: Lang) => WORDS[lang];
const tidyFrom = (f: ViewFrom): ViewFrom => ({
	name: clean(f.name, 200), ...(f.id !== undefined ? { id: clean(f.id, 400) } : {}), ...(f.role !== undefined ? { role: clean(f.role, 40) } : {}),
	...(f.workspace !== undefined ? { workspace: clean(f.workspace, 100) } : {}), ...(f.tab !== undefined ? { tab: clean(f.tab, 100) } : {}), ...(f.gone ? { gone: true as const } : {}),
});
export const tidyCard = (c: ViewCard): ViewCard => ({
	type: clean(c.type, 20), ...(c.lang !== undefined ? { lang: clean(c.lang, 10) } : {}), ...(c.happened !== undefined ? { happened: clean(c.happened, 1_000_000) } : {}), do: clean(c.do, 1_000_000),
	...(c.url !== undefined ? { url: clean(c.url, 1_000) } : {}), ...(c.command !== undefined ? { command: c.command.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2060-\u206f\ufeff]/gu, " ") } : {}), ...(c.after !== undefined ? { after: clean(c.after, 1_000_000) } : {}),
	...(c.options ? { options: c.options.map((o) => ({ label: clean(o.label, 200), then: clean(o.then, 1_000_000) })) } : {}), ...(c.secret ? { secret: { name: clean(c.secret.name, 400) } } : {}), ...(c.from ? { from: tidyFrom(c.from) } : {}),
});

/** Everything the file holds is cleaned again before it is shown, as the brief does (a writer of memory.json could put escapes or line breaks there to disguise what a confirm applies). */
export const tidy = (v: View): View => ({
	...v,
	entries: v.entries.map((e) => ({ ...e, id: clean(e.id, 20), text: clean(e.text, 1_000_000), ...(e.on !== undefined ? { on: clean(e.on, 100) } : {}), ...(e.outcome !== undefined ? { outcome: clean(e.outcome, 1_000) } : {}), ...(e.card ? { card: tidyCard(e.card) } : {}) })),
	proposals: v.proposals.map((p) => ({ ...p, id: clean(p.id, 20), text: clean(p.text, 1_000_000), ...(p.target !== undefined ? { target: clean(p.target, 20) } : {}), ...(p.cites !== undefined ? { cites: clean(p.cites, 1_000_000) } : {}) })),
});

/** The memory as text: the proposals waiting for the boss first, then standing instructions, decisions, and waits. */
function render(ws: string, v: View, lang: Lang): string {
	const w = WORDS[lang], of = (kind: string) => v.entries.filter((e) => e.kind === kind), part = (title: string, rows: string[]) => (rows.length ? [title, ...rows] : []);
	const detail = (c: ViewCard) => [
		...(c.url ? [`    ${w.where}: ${c.url}`] : []), ...(c.command ? [`    ${w.run}:`, ...c.command.split("\n").map((l) => `      ${l}`)] : []), ...(c.after ? [`    ${w.after}: ${c.after}`] : []),
		...(c.secret ? [`    ${w.secretName}: ${c.secret.name}`] : []), ...(c.options ?? []).map((o, i) => `    ${i + 1}) ${o.label} — ${o.then}`),
	];
	const row = (e: View["entries"][number]) => `${e.id}  ${e.kind === "wait" ? `${e.for === "boss" ? w.forBoss : w.forAgent(e.on ?? "?")}${e.card ? ` (${e.card.type}${e.card.from ? `, ${lang === "zh-TW" ? "由" : "from"} ${e.card.from.name}` : ""})` : ""}: ` : ""}${e.text}${e.kind === "wait" ? w.state(e.state, e.outcome, e.for === "boss") : ""}${e.card ? `\n${detail(e.card).join("\n")}`.trimEnd() : ""}`;
	return [
		w.head(ws, [of("standing").length, of("decision").length, of("wait").length, v.proposals.length]), ...(v.entries.length || v.proposals.length ? [] : [w.none]),
		...part(w.proposals(v.proposals[0]?.id ?? "P1", ws), v.proposals.flatMap((p) => [p.op === "add" ? w.propAdd(p.id, KIND[lang][p.kind], p.text) : w.propRetire(p.id, p.target, p.text), ...(p.cites ? [w.cites(p.cites)] : [])])),
		...part(w.standing, of("standing").map(row)), ...part(w.decisions, of("decision").reverse().map(row)), ...part(w.waits, of("wait").map(row)),
	].join("\n");
}

export interface MemoryCmdDeps {
	lang: Lang;
	/** This session's workspace id; undefined when it is in none. */
	own: string | undefined;
	/** One request to the sb server's `tower-memory` command for a workspace: its reply, whose `status` and `body` are the memory route's. */
	ask(workspace: string, json: Record<string, unknown>): Promise<{ ok: boolean; error?: string; status?: number; body?: Record<string, unknown> }>;
	workspaces(): Promise<{ workspace_id: string; label: string }[]>;
	/** True when the pi session has a screen (`ctx.hasUI`): a print or RPC run (`pi -p`) has none, and its memory writes are refused. */
	interactive: boolean;
	tell(text: string, level?: "info" | "warning" | "error"): void;
}
/** The workspaces a typed id or label names (`-w <id | label>` of `/boss memory` and `/boss tower`): one means it is found. */
export const matchWorkspaces = <T extends { workspace_id: string; label: string }>(all: T[], query: string): T[] => all.filter((x) => x.workspace_id === query || x.label === query);
/** `/boss memory <args>`. */
export async function runMemoryCommand(args: string, d: MemoryCmdDeps): Promise<void> {
	const w = WORDS[d.lang], parsed = parseMemoryArgs(args);
	if ("usage" in parsed) return d.tell(w.usage, "warning");
	if (parsed.op !== "list" && !d.interactive) return d.tell(w.noUi, "error");
	try {
		let ws = d.own;
		if (parsed.workspace === "head") ws = HEAD_KEY;
		else if (parsed.workspace) {
			const all = await d.workspaces(), found = matchWorkspaces(all, parsed.workspace);
			if (found.length !== 1) throw new Error(w.noMatch(parsed.workspace, all.map((x) => `${x.workspace_id} (${x.label})`).join(", ")));
			ws = found[0]!.workspace_id;
		}
		if (!ws) throw new Error(w.noWorkspace);
		const target = ws;
		const call = async (json: Record<string, unknown>) => {
			const r = await d.ask(target, json);
			if (!r.ok) throw new Error(w.noTower(target, r.error ?? "no answer"));
			if (r.status !== 200) throw new Error(String(r.body?.reason ?? r.body?.error ?? r.status));
			return r.body!;
		};
		// SAFETY: the body of a `read` is the memory route's `view` (towermemory.ts), whose shape `View` repeats.
		const view = tidy((await call({ op: "read" })) as unknown as View);
		const say = (text: string) => d.tell(text);
		switch (parsed.op) {
			case "list": return say(render(target, view, d.lang));
			case "confirm": case "reject": {
				const p = view.proposals.find((x) => x.id === parsed.id);
				if (!p) throw new Error(w.noProposal(parsed.id));
				if (parsed.op === "reject") return void (await call({ op: "reject", proposal: p.id }), say(w.rejected(p.id, target, p.text)));
				const done = await call({ op: "confirm", proposal: p.id, rev: view.rev });
				return say(p.op === "add" ? w.confirmedAdd(p.id, target, String(done.id), p.text) : w.confirmedRetire(p.id, target, p.target, p.text));
			}
			case "add": {
				const done = await call({ op: "add", kind: parsed.kind, text: parsed.text, rev: view.rev });
				return say(w.kept(String(done.id), parsed.text));
			}
			case "edit": return void (await call({ op: "edit", id: parsed.id, text: parsed.text, rev: view.rev }), say(w.edited(parsed.id)));
			case "delete": return void (await call({ op: "delete", id: parsed.id, rev: view.rev }), say(w.deleted(parsed.id)));
			case "resolve": return void (await call({ op: "resolve", id: parsed.id, ...(parsed.outcome ? { outcome: parsed.outcome } : {}), rev: view.rev }), say(w.resolved(parsed.id)));
			case "done": case "choose": case "decline": case "restate": {
				const entry = view.entries.find((x) => x.id === parsed.id), name = entry?.card?.from?.name ?? "";
				const option = parsed.op === "choose" ? parsed.option - 1 : undefined, picked = option === undefined ? undefined : entry?.card?.options?.[option];
				if (parsed.op === "choose" && !picked) throw new Error(w.noOption(parsed.id, parsed.option));
				// In pi the boss is at the terminal: the first step of a secret card is taken for them, so `done` closes it (the server's table wants it before `done`).
				if (parsed.op === "done" && entry?.card?.type === "secret" && !entry.press?.secretAsked) await call({ op: "press", id: parsed.id, act: "secret" });
				const act = parsed.op, done = await call({ op: "press", id: parsed.id, act, ...(option !== undefined ? { option } : {}), ...(parsed.op === "decline" && parsed.reason ? { reason: parsed.reason } : {}) });
				const status = (done.press as { main?: { status: string } } | undefined)?.main?.status;
				const note = !name || !status ? "" : status === "delivered" || status === "queued" ? w.told(name) : w.notReached(name, status);
				const what = act === "done" ? w.didDone : act === "choose" ? w.didChose(picked!.label) : act === "decline" ? w.didDecline : w.didRestate;
				return say(w.pressed(parsed.id, what, note));
			}
		}
	} catch (error) {
		d.tell((error as Error).message, "error");
	}
}
