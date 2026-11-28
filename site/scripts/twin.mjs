// The checks of docs/how-it-works.zh-TW.md against the English file that fail `sync.mjs --check` and so block the Pages build, with no dependency
// beyond Node: `tests/twin.test.ts` runs them in `npm test`, before a push, and `sync.mjs` prints them. Drift since the source commit (git) stays
// `sync.mjs`'s warning, not a failure, and is not here; whether that commit is in the branch's history at all (git) is, as `sourceInHistory`.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** The site's pages under src/content/docs that sync.mjs writes; the bold check skips them (their source is docs/). */
export const GENERATED = ["reference/how-it-works", "guide/unattended-device.md", "releases"];

/** Headings outside code fences: their line index, level, and text. */
export function headingLines(lines) {
	const out = [];
	let fence = false;
	lines.forEach((line, i) => {
		if (/^\s*```/.test(line)) fence = !fence;
		const m = !fence && /^(#{1,6}) (.*)$/.exec(line);
		if (m) out.push({ i, level: m[1].length, text: m[2] });
	});
	return out;
}

const PUNCT = /[\p{P}\p{S}]/u;
const SPACE = /\s/u;

// The 1-based lines of `text` holding a `**` that is not bold under CommonMark's flanking rule. A delimiter that opens needs a
// non-space after it, and a punctuation mark after it only when a space or punctuation lies before it; a delimiter that closes
// is the mirror. Code fences are skipped, and inline code counts as its backticks (punctuation). `**` pairs are taken in order, as the parser pairs a line's runs.
export function brokenBold(text) {
	const out = [];
	let fence = false;
	text.split("\n").forEach((line, i) => {
		if (/^\s*```/.test(line)) fence = !fence;
		if (fence || !line.includes("**")) return;
		const plainLine = line.replace(/`[^`]*`/g, (m) => "`".repeat(m.length));
		const runs = [...plainLine.matchAll(/\*\*+/g)].filter((m) => m[0].length === 2);
		let bad = false;
		runs.forEach((m, n) => {
			const before = m.index > 0 ? plainLine[m.index - 1] : " ";
			const after = m.index + 2 < plainLine.length ? plainLine[m.index + 2] : " ";
			const left = !SPACE.test(after) && (!PUNCT.test(after) || SPACE.test(before) || PUNCT.test(before));
			const right = !SPACE.test(before) && (!PUNCT.test(before) || SPACE.test(after) || PUNCT.test(after));
			if (n % 2 === 0 ? !left : !right) bad = true;
		});
		if (bad) out.push(i + 1);
	});
	return out;
}

// The kind of one line, by what Markdown makes of it; lines inside a code fence are all "code".
function lineKinds(lines) {
	let fence = false;
	return lines.map((line) => {
		if (/^\s*```/.test(line)) return (fence = !fence), "fence";
		if (fence) return "code";
		if (!line.trim()) return "blank";
		const h = /^(#{1,6}) /.exec(line);
		if (h) return `h${h[1].length}`;
		if (line.startsWith("|")) return "row";
		if (/^\s*[-*] /.test(line)) return "bullet";
		if (/^\s*\d+\. /.test(line)) return "number";
		return "text";
	});
}

// The line-for-line check: the 1-based lines where the twin's line differs from the English line in kind, or lacks a backticked token the
// English line has (the twin may add tokens, such as the zh-TW form of a message). Returns a message when the line counts differ.
export function twinDrift(enLines, zhLines) {
	if (enLines.length !== zhLines.length) return { message: `${enLines.length} lines in English, ${zhLines.length} in zh-TW` };
	const [ke, kz] = [lineKinds(enLines), lineKinds(zhLines)];
	const bad = [];
	enLines.forEach((line, i) => {
		if (ke[i] !== kz[i]) return bad.push(i + 1);
		if (ke[i] === "code" || ke[i] === "fence") return;
		const have = new Map();
		for (const t of zhLines[i].match(/`[^`]+`/g) ?? []) have.set(t, (have.get(t) ?? 0) + 1);
		for (const t of line.match(/`[^`]+`/g) ?? []) {
			if (!have.get(t)) return bad.push(i + 1);
			have.set(t, have.get(t) - 1);
		}
	});
	return { bad };
}

/** The source commit the twin's first line names, if any. */
export const sourceOf = (zhText) => /<!-- source: docs\/how-it-works\.md @ ([0-9a-f]{7,40}) -->/.exec(zhText)?.[1];

/**
 * Whether the source commit is in the history of HEAD (`ours`). A twin marked on a branch that was then rebased or squashed names a commit the branch no longer has (`outside`): `git log <sha>..HEAD` then fails
 * where only the branch was fetched (the Pages build, 0.107.0 to 0.113.0) and lists the wrong commits where the old one is still around. `shallow`: the clone has not the history to tell.
 * @param {string} repo @param {string} sha @returns {"ours" | "outside" | "shallow"}
 */
export function sourceInHistory(repo, sha) {
	const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	if (git("rev-parse", "--is-shallow-repository").stdout.trim() === "true") return "shallow";
	return git("merge-base", "--is-ancestor", sha, "HEAD").status === 0 ? "ours" : "outside";
}

const mdFiles = (dir) => readdirSync(dir).flatMap((f) => {
	const path = join(dir, f);
	return statSync(path).isDirectory() ? mdFiles(path) : /\.mdx?$/.test(f) ? [path] : [];
});

/** Every failure of the twin and bold checks, one line each (none: the twin passes). `repo` is the checkout's root. */
export function twinProblems(repo) {
	const docs = join(repo, "docs"), zhSite = join(repo, "site/src/content/docs/zh-tw");
	const read = (path) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } };
	const en = read(join(docs, "how-it-works.md")), zh = read(join(docs, "how-it-works.zh-TW.md"));
	const out = [];
	if (!zh) return ["docs/how-it-works.zh-TW.md: missing"];
	const a = headingLines(en.split("\n")), b = headingLines(zh.split("\n"));
	if (a.length !== b.length) out.push(`headings: ${a.length} in English, ${b.length} in zh-TW`);
	a.forEach((h, n) => {
		if (b[n] && b[n].level !== h.level) out.push(`heading ${n + 1} ("${h.text}"): level ${h.level} in English, ${b[n].level} in zh-TW`);
	});
	const drift = twinDrift(en.split("\n"), zh.split("\n"));
	if (drift.message) out.push(`line for line: ${drift.message}`);
	else if (drift.bad.length) out.push(`line for line: ${drift.bad.length} lines of docs/how-it-works.zh-TW.md differ from the English line of the same number in kind or backticked tokens (a paragraph split elsewhere than in English?), first at ${drift.bad.slice(0, 12).join(", ")}`);
	if (!sourceOf(zh)) out.push("docs/how-it-works.zh-TW.md: no `<!-- source: docs/how-it-works.md @ <commit> -->` line");
	for (const path of mdFiles(zhSite)) {
		if (GENERATED.some((g) => relative(zhSite, path).startsWith(g))) continue;
		const lines = brokenBold(read(path));
		if (lines.length) out.push(`${relative(repo, path)}: bold the page cannot show, at lines ${lines.join(", ")}`);
	}
	for (const f of readdirSync(docs).filter((f) => /\.zh-TW\.md$/.test(f))) {
		const lines = brokenBold(read(join(docs, f)));
		if (lines.length) out.push(`docs/${f}: bold the page cannot show (move the punctuation outside the ** or put a space after it), at lines ${lines.join(", ")}`);
	}
	return out;
}
