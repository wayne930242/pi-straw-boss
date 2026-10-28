// `/boss memory` (docs/specs/2026-10-26-sb-backend.md, Tower memory): the boss's pi interface to the tower's memory, first among equals; the GUI panel mirrors it and adds nothing of its own. Every operation (list,
// confirm or reject a run's proposal, add, edit, delete, resolve a wait) is one request to the sb server's `tower-memory` command, which runs the very function the GUI's POST route runs (towermemory.ts
// `memoryRequest`): the same refusals, the same rev check (each write names the rev this command has just read). A slash command is typed by the boss and nothing else reaches it: no tool of a run exposes it,
// and the server refuses `tower-memory` to a run token. Its own words come in English and Traditional Chinese (the page has Paraglide; a pi session has this table); the server's refusals stay as it wrote them.

export type Lang = "en" | "zh-TW";
/** Traditional Chinese for a zh-TW, zh-HK, zh-MO, or zh-Hant locale, as the shell names it; English otherwise. */
export const memoryLang = (env: NodeJS.ProcessEnv): Lang => (/^zh[_-](TW|HK|MO|Hant)/i.test(env.LC_ALL || env.LC_MESSAGES || env.LANG || "") ? "zh-TW" : "en");

type Id = { id: string };
export type MemoryArgs =
	| { op: "list" } | ({ op: "confirm" | "reject" } & Id) | { op: "add"; kind: "standing" | "decision"; text: string }
	| ({ op: "edit"; text: string } & Id) | ({ op: "delete" } & Id) | ({ op: "resolve"; outcome?: string } & Id);
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
	return usage;
}

interface View {
	rev: number;
	entries: { id: string; kind: "standing" | "decision" | "wait"; text: string; for?: "boss" | "agent"; on?: string; state?: string; outcome?: string }[];
	proposals: { id: string; op: "add" | "retire"; kind: "standing" | "decision"; text: string; target?: string; cites?: string }[];
}
const KIND = { en: { standing: "standing", decision: "decision" }, "zh-TW": { standing: "常駐指示", decision: "決定" } } as const;
const WORDS = {
	en: {
		usage: "Usage: /boss memory [-w workspace] [list | confirm P1 | reject P1 | add standing|decision <text> | edit S1 <text> | delete D1 | resolve W1 [outcome]]",
		noWorkspace: "This session is not in a Herdr workspace: name one with -w <workspace id or label>.",
		noMatch: (q: string, all: string) => `No workspace matches "${q}". Workspaces: ${all}`,
		noTower: (ws: string, why: string) => `No tower memory for ${ws}: ${why}`,
		noProposal: (id: string) => `No such proposal ${id}: /boss memory shows the ones that wait`,
		head: (ws: string, n: number[]) => `Memory (${ws}): ${n[0]} standing · ${n[1]} decisions · ${n[2]} waits${n[3] ? ` · ${n[3]} proposals to confirm` : ""}`,
		none: "Nothing is kept.",
		proposals: (id: string) => `Proposals from the tower (/boss memory confirm ${id} · reject ${id}):`,
		propAdd: (id: string, kind: string, text: string) => `${id} add ${kind}: ${text}`,
		propRetire: (id: string, target: string | undefined, text: string) => `${id} retire ${target}: ${text}`,
		cites: (text: string) => `    from your message: ${text}`,
		standing: "Standing instructions:", decisions: "Decisions (newest first):", waits: "Waits:",
		forBoss: "for you", forAgent: (who: string) => `for ${who}`, state: (s?: string, outcome?: string) => (s === "answered" ? " (answered?)" : s === "resolved" ? ` (resolved${outcome ? `: ${outcome}` : ""})` : s === "expired" ? " (expired)" : ""),
		confirmedAdd: (p: string, id: string, text: string) => `${p} confirmed: ${id} kept: ${text}`,
		confirmedRetire: (p: string, id: string | undefined, text: string) => `${p} confirmed: ${id} retired: ${text}`,
		rejected: (p: string) => `${p} rejected.`, kept: (id: string, text: string) => `${id} kept: ${text}`, edited: (id: string) => `${id} edited.`, deleted: (id: string) => `${id} deleted.`, resolved: (id: string) => `${id} resolved.`,
	},
	"zh-TW": {
		usage: "用法：/boss memory [-w workspace] [list | confirm P1 | reject P1 | add standing|decision <內容> | edit S1 <內容> | delete D1 | resolve W1 [結果]]",
		noWorkspace: "這個 session 不在任何 Herdr workspace 裡：用 -w <workspace id 或名稱> 指定。",
		noMatch: (q: string, all: string) => `沒有符合「${q}」的 workspace。現有：${all}`,
		noTower: (ws: string, why: string) => `${ws} 沒有塔台記憶可用：${why}`,
		noProposal: (id: string) => `沒有這則提議 ${id}：/boss memory 會列出等你確認的`,
		head: (ws: string, n: number[]) => `記憶（${ws}）：${n[0]} 常駐指示・${n[1]} 決定・${n[2]} 等待${n[3] ? `・${n[3]} 則待你確認` : ""}`,
		none: "沒有保存任何內容。",
		proposals: (id: string) => `塔台的提議（/boss memory confirm ${id}・reject ${id}）：`,
		propAdd: (id: string, kind: string, text: string) => `${id} 新增${kind}：${text}`,
		propRetire: (id: string, target: string | undefined, text: string) => `${id} 撤掉 ${target}：${text}`,
		cites: (text: string) => `    你的訊息：${text}`,
		standing: "常駐指示：", decisions: "決定（新到舊）：", waits: "等待：",
		forBoss: "等你", forAgent: (who: string) => `等 ${who}`, state: (s?: string, outcome?: string) => (s === "answered" ? "（可能已回覆）" : s === "resolved" ? `（已處理${outcome ? `：${outcome}` : ""}）` : s === "expired" ? "（已失效）" : ""),
		confirmedAdd: (p: string, id: string, text: string) => `${p} 已確認：${id} 已保存：${text}`,
		confirmedRetire: (p: string, id: string | undefined, text: string) => `${p} 已確認：${id} 已撤掉：${text}`,
		rejected: (p: string) => `${p} 已駁回。`, kept: (id: string, text: string) => `${id} 已保存：${text}`, edited: (id: string) => `${id} 已改。`, deleted: (id: string) => `${id} 已刪。`, resolved: (id: string) => `${id} 已處理。`,
	},
};

/** The memory as text: the proposals waiting for the boss first, then standing instructions, decisions, and waits. */
function render(ws: string, v: View, lang: Lang): string {
	const w = WORDS[lang], of = (kind: string) => v.entries.filter((e) => e.kind === kind), part = (title: string, rows: string[]) => (rows.length ? [title, ...rows] : []);
	const row = (e: View["entries"][number]) => `${e.id}  ${e.kind === "wait" ? `${e.for === "boss" ? w.forBoss : w.forAgent(e.on ?? "?")}: ` : ""}${e.text}${e.kind === "wait" ? w.state(e.state, e.outcome) : ""}`;
	return [
		w.head(ws, [of("standing").length, of("decision").length, of("wait").length, v.proposals.length]), ...(v.entries.length || v.proposals.length ? [] : [w.none]),
		...part(w.proposals(v.proposals[0]?.id ?? "P1"), v.proposals.flatMap((p) => [p.op === "add" ? w.propAdd(p.id, KIND[lang][p.kind], p.text) : w.propRetire(p.id, p.target, p.text), ...(p.cites ? [w.cites(p.cites)] : [])])),
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
	tell(text: string, level?: "info" | "warning" | "error"): void;
}
/** `/boss memory <args>`. */
export async function runMemoryCommand(args: string, d: MemoryCmdDeps): Promise<void> {
	const w = WORDS[d.lang], parsed = parseMemoryArgs(args);
	if ("usage" in parsed) return d.tell(w.usage, "warning");
	try {
		let ws = d.own;
		if (parsed.workspace) {
			const all = await d.workspaces(), found = all.filter((x) => x.workspace_id === parsed.workspace || x.label === parsed.workspace);
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
		const view = (await call({ op: "read" })) as unknown as View;
		const say = (text: string) => d.tell(text);
		switch (parsed.op) {
			case "list": return say(render(target, view, d.lang));
			case "confirm": case "reject": {
				const p = view.proposals.find((x) => x.id === parsed.id);
				if (!p) throw new Error(w.noProposal(parsed.id));
				if (parsed.op === "reject") return void (await call({ op: "reject", proposal: p.id }), say(w.rejected(p.id)));
				const done = await call({ op: "confirm", proposal: p.id, rev: view.rev });
				return say(p.op === "add" ? w.confirmedAdd(p.id, String(done.id), p.text) : w.confirmedRetire(p.id, p.target, p.text));
			}
			case "add": {
				const done = await call({ op: "add", kind: parsed.kind, text: parsed.text, rev: view.rev });
				return say(w.kept(String(done.id), parsed.text));
			}
			case "edit": return void (await call({ op: "edit", id: parsed.id, text: parsed.text, rev: view.rev }), say(w.edited(parsed.id)));
			case "delete": return void (await call({ op: "delete", id: parsed.id, rev: view.rev }), say(w.deleted(parsed.id)));
			case "resolve": return void (await call({ op: "resolve", id: parsed.id, ...(parsed.outcome ? { outcome: parsed.outcome } : {}), rev: view.rev }), say(w.resolved(parsed.id)));
		}
	} catch (error) {
		d.tell((error as Error).message, "error");
	}
}
