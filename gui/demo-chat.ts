import type { Item } from "../src/items.ts";

// A demo chat history for `npm run gui:dev`: invented content with every item kind, long enough to page (older pages load on scroll).

const at = (n: number) => new Date(Date.UTC(2026, 9, 17, 8, 0, 0) + n * 47_000).toISOString();
const LONG = Array.from({ length: 60 }, (_, i) => `line ${i + 1}: build step finished without warnings`).join("\n");
export const WHOLE = JSON.stringify({ path: "billing/ledger.ts", content: LONG }, null, 1); // a call whose arguments the log shows cut
const REPLY = "Here is what I found in `billing/ledger.ts`:\n\n- The rounding happens **before** the tax is applied\n- `sumLines()` ignores credit notes\n- [ ] add a regression test\n\n| step | result |\n|---|---|\n| lint | ok |\n| unit | 41 passed |\n\n```ts\nconst total = lines.reduce((sum, l) => sum + l.cents, 0);\n```\n\nRaw <b>HTML</b> stays text, and see https://example.com/docs for more.";

export const DEMO_DOC = "# Rollout plan\n\nRead-only demo document, opened as a tile beside the comms log.\n\n## Steps\n\n1. Ship the ledger fix to staging\n2. Watch the rounding metric for a day\n3. Promote to production\n\n- [x] regression test written\n- [ ] credit notes reviewed\n\n| window | owner |\n|---|---|\n| Tue 16:00 | ops-main |\n\n> Raw <b>HTML</b> stays text here too.";

/** A demo HTML document as show_doc pages look (no script, a pi-answer form), shown in the sandboxed frame. */
export const DEMO_PAGE = `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:22px;font:15px/1.55 Georgia,serif;background:#f6efdc;color:#2b2416}h1{margin:0 0 4px;font-size:22px}p.k{margin:0 0 14px;color:#7a6a48;font:12px system-ui}table{border-collapse:collapse;margin:10px 0}td,th{border:1px solid #cdbf98;padding:4px 10px}form{margin-top:14px;padding:12px;border:1px dashed #b49b62;border-radius:8px}button{padding:5px 14px}</style><h1>Ledger fix review</h1><p class="k">billing-main · for review</p><p>Rounding now happens <b>after</b> the tax is applied, and credit notes count.</p><table><tr><th>check</th><th>result</th></tr><tr><td>unit</td><td>43 passed</td></tr><tr><td>staging</td><td>green</td></tr></table><form action="cgi-bin:pi-answer"><label><input type="radio" name="window" value="tonight" checked> Tonight 22:00</label><br><label><input type="radio" name="window" value="tomorrow"> Tomorrow 08:00</label><br><button>Send to billing-main</button></form>`;

/** Items in file order: round r is a user message, a thinking assistant with two tool calls and their results, then a reply. */
export function demoHistory(rounds = 70): Item[] {
	const out: Item[] = [{ id: "m0", kind: "meta", text: "model demo/harbor-1", at: at(0) }, { id: "m1", kind: "meta", text: "thinking medium", at: at(0) }];
	for (let r = 1; r <= rounds; r++) {
		const t = r * 6;
		out.push({ id: `u${r}`, kind: "user", text: r === 1 ? "Please check the ledger rounding.\nThe docs are at https://example.com/ledger" : `Round ${r}: and what about the credit notes?`, ...(r === 70 ? { images: 2 } : {}), at: at(t) });
		out.push({ id: `a${r}`, kind: "assistant", model: "harbor-1", at: at(t + 1), thought: 340, text: r % 9 === 0 ? undefined : "Let me look at the code first.", ctx: 12_000 + r * 900, tools: [
			{ id: `c${r}a`, name: "bash", summary: "git grep -n sumLines", args: JSON.stringify({ command: "git grep -n sumLines", timeout: 30 }, null, 1) },
			r === 68 ? { id: `c${r}b`, name: "write", summary: "billing/ledger.ts", args: WHOLE.slice(0, 1500), cut: true } : { id: `c${r}b`, name: "read", summary: "billing/ledger.ts", args: JSON.stringify({ path: "billing/ledger.ts" }, null, 1) },
		] });
		out.push({ id: `r${r}a`, kind: "result", callId: `c${r}a`, name: "bash", isError: r % 11 === 0, text: "billing/ledger.ts:42:export function sumLines(", bytes: 52, images: 0, at: at(t + 2) });
		out.push({ id: `r${r}b`, kind: "result", callId: `c${r}b`, name: r === 68 ? "write" : "read", isError: false, text: LONG.slice(0, 2048), more: true, bytes: 40_000, images: r === 70 ? 1 : 0, at: at(t + 3) });
		out.push({ id: `b${r}`, kind: "assistant", model: "harbor-1", at: at(t + 4), text: REPLY, ctx: 13_000 + r * 900, stop: r === 7 ? "error" : undefined, error: r === 7 ? "Provider returned 529: overloaded" : undefined });
		if (r === 20) out.push({ id: "k1", kind: "divider", type: "compaction", tokens: 184_000, text: "## Goal\nFix ledger rounding.\n\n## Done\nRead the ledger code.", at: at(t + 5) });
		if (r === 30) out.push({ id: "n1", kind: "notice", type: "subagent_result", from: "lint-sweep", text: 'Sub-agent "lint-sweep" completed (4m 1s).\n\nNo findings.', link: "a1/lint", at: at(t + 5) });
		if (r === 40) out.push({ id: "n2", kind: "notice", type: "intercom_message", from: "ops-main", text: "Deploy window moved to 16:00.", at: at(t + 5) });
		if (r === 69) out.push({ id: "sd1", kind: "assistant", model: "harbor-1", at: at(t + 5), text: "I wrote the rollout plan; it is open for review.", tools: [{ id: "sdc1", name: "show_doc", summary: "docs/rollout-plan.md", args: JSON.stringify({ paths: ["docs/rollout-plan.md"], reason: "Rollout plan ready" }, null, 1) }] }, { id: "sdr1", kind: "result", callId: "sdc1", name: "show_doc", text: "Opened docs/rollout-plan.md", isError: false, bytes: 30, at: at(t + 5) });
		if (r === 70) out.push({ id: "q1", kind: "assistant", model: "harbor-1", at: at(t + 5), text: "Two things before I ship.", tools: [{ id: "qc1", name: "ask_user_question", summary: "Ship · Channels", args: JSON.stringify({ questions: [{ question: "Ship the ledger fix tonight?", header: "Ship", options: [{ label: "Yes", description: "Go ahead" }, { label: "No", description: "Hold" }] }, { question: "Which channels?", header: "Channels", multiSelect: true, options: [{ label: "email", description: "Mail" }, { label: "chat", description: "Team chat" }] }] }, null, 1) }] }, { id: "qr1", kind: "result", callId: "qc1", name: "ask_user_question", text: 'User has answered your questions: "Ship the ledger fix tonight?"="Yes". "Which channels?"="chat".', isError: false, bytes: 96, at: at(t + 5) });
		if (r === 50) out.push({ id: "x1", kind: "bash", command: "npm test", exit: 1, text: "1 failing\n  ledger rounds half up", at: at(t + 5) });
	}
	return out;
}

/** A demo pane's screen at tick n, as pi in a framed theme draws it (SGR only): the spinner and the test count change every tick. */
export function demoScreen(name: string, n: number): string[] {
	const [gold, dim, ok, rule] = ["\x1b[38;2;249;226;175m", "\x1b[2m", "\x1b[38;5;114m", "─".repeat(58)], end = "\x1b[0m";
	return [`${gold}╭─ pi · ${name} ${rule.slice(name.length + 8)}╮${end}`, "", ` \x1b[1;38;2;137;180;250mYou${end}  ship the billing fix and run the tests`, "", ` ${ok}●${end} bash ${dim}npm test -- billing${end}`, `   ${ok}✓${end} ${41 + (n % 9)} passed ${dim}· 0 failed${end}`, ` ${ok}●${end} edit ${dim}billing/ledger.ts${end} \x1b[32m+12\x1b[0m \x1b[31m-3${end}`, "", ` \x1b[33m${"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[n % 10]}${end} Working… ${dim}(${n}s · esc to interrupt)${end}`, "", `${gold}╭${rule}╮${end}`, `${gold}│${end} \x1b[7m ${end}${" ".repeat(56)}${gold}│${end}`, `${gold}╰${rule}╯${end}`, ` \x1b[38;2;203;166;247mharbor-1${end} ${dim}· 42k tokens · ~/work/harbor-api${end}`];
}
