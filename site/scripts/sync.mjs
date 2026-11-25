// Generates the site's reference pages from the repository's own Markdown, so docs/ stays the one source:
// docs/how-it-works.md (and its zh-TW twin) split by H2, docs/unattended-device*.md, docs/releases/*.md, and the images.
// Links are rewritten to absolute site paths (the links validator checks them) or to GitHub for files the site does not publish.
// `--check` reports whether docs/how-it-works.zh-TW.md still matches the English file: line for line (same line count, same kind of line,
// every backticked token of an English line on the same zh-TW line; error), heading structure (error), and drift since the source commit (warning),
// and every `**` that CommonMark would not turn into bold (CJK punctuation beside it), in the site's own zh pages and in docs/*.zh-TW.md (error).
// The errors are twin.mjs's, which tests/twin.test.ts also runs in `npm test`; only the drift warning, which needs git, is here.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";
import { GENERATED, headingLines, sourceOf, twinProblems } from "./twin.mjs";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(SITE, "..");
const DOCS = join(REPO, "docs");
const CONTENT = join(SITE, "src/content/docs");
const BASE = "/pi-straw-boss/docs";
const GITHUB = "https://github.com/wayne930242/pi-straw-boss";
const LOCALES = { en: { dir: "", suffix: "" }, zh: { dir: "zh-tw", suffix: ".zh-TW" } };
// The first H2 repeats the document's own title; on the site it names what the section covers.
const TITLES = { "how-it-works": { en: "Roles and the tower", zh: "角色與塔台" } };

// Heading text as GitHub and Astro slug it: the rendered text, without code ticks, link targets, or emphasis marks.
const plain = (text) =>
	text
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/<[^>]+>/g, "")
		.replace(/(\*\*|__|\*|_)(.+?)\1/g, "$2")
		.trim();

// Headings outside code fences, with their line index, level, text, and slug in the whole document.
function headings(lines) {
	const slugger = new GithubSlugger();
	return headingLines(lines).map((h) => ({ ...h, slug: slugger.slug(plain(h.text)) }));
}

function read(path) {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

// The how-it-works index of one language: each H2 section becomes a page named by the English heading's slug, so both
// languages share URLs (Starlight's language switch keeps the path). anchors maps a whole-document slug to its page and in-page slug.
function hiwPlan(enText, text) {
	const en = headings(enText.split("\n"));
	const lines = text.split("\n");
	const own = headings(lines);
	if (own.length !== en.length || own.some((h, n) => h.level !== en[n].level))
		throw new Error("docs/how-it-works.zh-TW.md: its headings do not match docs/how-it-works.md (run `npm run check`)");
	const pages = [];
	const anchors = new Map();
	let page;
	own.forEach((h, n) => {
		if (h.level === 2) {
			page = { slug: en[n].slug, title: plain(h.text), start: h.i, slugger: new GithubSlugger() };
			pages.push(page);
			for (const s of [h.slug, en[n].slug]) anchors.set(s, { page: page.slug });
		} else if (page) {
			const local = page.slugger.slug(plain(h.text));
			for (const s of [h.slug, en[n].slug]) if (!anchors.has(s)) anchors.set(s, { page: page.slug, hash: local });
		}
	});
	pages.forEach((p, n) => (p.end = n + 1 < pages.length ? pages[n + 1].start : lines.length));
	// A heading renamed keeps its old slug as a line `<a id="old"></a>` under it (0.83.0: `the-watchdog` under Watches); the line is copied into the page, so the old slug lands there.
	for (const p of pages)
		for (let i = p.start; i < p.end; i++) {
			const m = /^<a id="([a-z0-9-]+)"><\/a>$/.exec(lines[i].trim());
			if (m && !anchors.has(m[1])) anchors.set(m[1], { page: p.slug, hash: m[1] });
		}
	const intro = { start: own[0]?.level === 1 ? own[0].i + 1 : 0, end: pages[0]?.start ?? lines.length, title: plain(own[0]?.text ?? "How it works") };
	return { lines, pages, anchors, intro };
}

const prefix = (lang) => `${BASE}/${LOCALES[lang].dir ? `${LOCALES[lang].dir}/` : ""}`;

// Rewrites one Markdown link target found in `from` (a path under docs/) for the page in `lang`.
function target(url, from, lang, ctx) {
	if (/^(https?:|mailto:)/.test(url)) return url;
	const [path, hash] = url.split("#");
	const hiw = (h) => {
		const a = h ? ctx.anchors[lang].get(h) ?? ctx.anchors.en.get(h) : undefined;
		if (h && !a) throw new Error(`${relative(REPO, from)}: no heading for #${h}`);
		return a ? `${prefix(lang)}reference/how-it-works/${a.page}/${a.hash ? `#${a.hash}` : ""}` : `${prefix(lang)}reference/how-it-works/`;
	};
	if (!path) return from.endsWith("how-it-works.md") || from.endsWith("how-it-works.zh-TW.md") ? hiw(hash) : url;
	const file = normalize(join(dirname(from), path));
	const rel = relative(REPO, file).replaceAll("\\", "/");
	if (/^docs\/how-it-works(\.zh-TW)?\.md$/.test(rel)) return hiw(hash);
	if (/^README(\.zh-TW)?\.md$/.test(rel)) return prefix(rel.includes("zh-TW") ? "zh" : lang);
	if (/^docs\/unattended-device(\.zh-TW)?\.md$/.test(rel)) {
		const l = rel.endsWith(".zh-TW.md") ? "zh" : lang;
		const h = hash && l === "zh" ? ctx.unattended.get(hash) ?? hash : hash;
		return `${prefix(l)}guide/unattended-device/${h ? `#${h}` : ""}`;
	}
	const release = /^docs\/releases\/(.+)\.md$/.exec(rel);
	if (release) return `${prefix("en")}releases/${release[1].replaceAll(".", "-")}/${hash ? `#${hash}` : ""}`;
	if (/^docs\/[^/]+\.(png|gif|jpe?g|svg|webp)$/.test(rel)) return `${BASE}/img/${rel.slice(5)}`;
	if (rel.startsWith("..")) return url;
	const kind = existsSync(file) && statSync(file).isDirectory() ? "tree" : "blob";
	return `${GITHUB}/${kind}/main/${rel}${hash ? `#${hash}` : ""}`;
}

function rewrite(text, from, lang, ctx) {
	let fence = false;
	return text
		.split("\n")
		.map((line) => {
			if (/^\s*```/.test(line)) fence = !fence;
			if (fence || /^\s*```/.test(line)) return line;
			return line
				.replace(/(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (_, a, url, b) => a + target(url, from, lang, ctx) + b)
				.replace(/(<img [^>]*src=")([^"]+)(")/g, (_, a, url, b) => a + target(url, from, lang, ctx) + b)
				.replace(/(<a [^>]*href=")([^"]+)(")/g, (_, a, url, b) => a + target(url, from, lang, ctx) + b);
		})
		.join("\n");
}

// Every heading one level up (### becomes ##), for a section that becomes a page whose title is its H2.
const demote = (body) => {
	let fence = false;
	return body
		.split("\n")
		.map((line) => {
			if (/^\s*```/.test(line)) fence = !fence;
			return !fence && /^#{3,6} /.test(line) ? line.slice(1) : line;
		})
		.join("\n");
};

const yaml = (s) => JSON.stringify(s);

function page(path, front, body) {
	mkdirSync(dirname(path), { recursive: true });
	const lines = Object.entries(front).map(([k, v]) => (typeof v === "object" ? `${k}:\n${Object.entries(v).map(([a, b]) => `  ${a}: ${yaml(b)}`).join("\n")}` : `${k}: ${yaml(v)}`));
	writeFileSync(path, `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`);
}

function check() {
	const problems = twinProblems(REPO);
	for (const line of problems) console.log(line);
	const zh = read(join(DOCS, "how-it-works.zh-TW.md")), sha = zh && sourceOf(zh);
	if (sha) {
		const log = execFileSync("git", ["log", "--oneline", `${sha}..HEAD`, "--", "docs/how-it-works.md"], { cwd: REPO, encoding: "utf8" }).trim();
		if (log) console.log(`docs/how-it-works.md changed since the translation (${sha}); bring these into docs/how-it-works.zh-TW.md:\n${log}`);
		else console.log(`docs/how-it-works.zh-TW.md matches docs/how-it-works.md at ${sha}`);
	}
	return problems.length ? 1 : 0;
}

function sync() {
	for (const lang of Object.keys(LOCALES)) for (const g of GENERATED) rmSync(join(CONTENT, LOCALES[lang].dir, g), { recursive: true, force: true });
	rmSync(join(SITE, "public/img"), { recursive: true, force: true });
	mkdirSync(join(SITE, "public/img"), { recursive: true });
	for (const f of readdirSync(DOCS)) if (/\.(png|gif|jpe?g|svg|webp)$/.test(f)) copyFileSync(join(DOCS, f), join(SITE, "public/img", f));

	const enText = read(join(DOCS, "how-it-works.md"));
	const zhText = read(join(DOCS, "how-it-works.zh-TW.md"));
	const plans = { en: hiwPlan(enText, enText) };
	if (zhText) plans.zh = hiwPlan(enText, zhText);
	// The zh-TW setup page's headings, by the English slug of the heading in the same place, for links written against the English page.
	const ud = ["", ".zh-TW"].map((s) => headings((read(join(DOCS, `unattended-device${s}.md`)) ?? "").split("\n")));
	const unattended = new Map(ud[0].length === ud[1].length ? ud[0].map((h, n) => [h.slug, ud[1][n].slug]) : []);
	const ctx = { anchors: { en: plans.en.anchors, zh: plans.zh?.anchors ?? plans.en.anchors }, unattended };

	for (const [lang, plan] of Object.entries(plans)) {
		const src = join(DOCS, `how-it-works${LOCALES[lang].suffix}.md`);
		const dir = join(CONTENT, LOCALES[lang].dir, "reference/how-it-works");
		const edit = `${GITHUB}/edit/main/docs/how-it-works${LOCALES[lang].suffix}.md`;
		const intro = plan.lines.slice(plan.intro.start, plan.intro.end).join("\n").replace(/<!-- source:[^>]*-->/, "");
		page(join(dir, "index.md"), { title: plan.intro.title, editUrl: edit, sidebar: { order: 0, label: lang === "zh" ? "總覽" : "Overview" } }, rewrite(intro, src, lang, ctx));
		plan.pages.forEach((p, n) => {
			const body = demote(plan.lines.slice(p.start + 1, p.end).join("\n"));
			page(join(dir, `${p.slug}.md`), { title: TITLES[p.slug]?.[lang] ?? p.title, editUrl: edit, sidebar: { order: n + 1 } }, rewrite(body, src, lang, ctx));
		});
	}

	for (const lang of Object.keys(LOCALES)) {
		const src = join(DOCS, `unattended-device${LOCALES[lang].suffix}.md`);
		const text = read(src);
		if (!text) continue;
		const [, title, body] = /^# (.*)\n([\s\S]*)$/.exec(text);
		page(join(CONTENT, LOCALES[lang].dir, "guide/unattended-device.md"), { title, editUrl: `${GITHUB}/edit/main/docs/unattended-device${LOCALES[lang].suffix}.md` }, rewrite(body.replace(/^\s*\[[^\n]*(English|繁體中文)[^\n]*\n/, ""), src, lang, ctx));
	}

	const versions = readdirSync(join(DOCS, "releases"))
		.filter((f) => /^\d+\.\d+\.\d+\.md$/.test(f))
		.map((f) => f.slice(0, -3))
		.sort((x, y) => {
			const [a, b] = [x, y].map((v) => v.split(".").map(Number));
			return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
		});
	versions.forEach((v, n) => {
		const src = join(DOCS, "releases", `${v}.md`);
		const body = read(src).replace(/^# .*\n/, "");
		page(join(CONTENT, "releases", `${v.replaceAll(".", "-")}.md`), { title: v, editUrl: `${GITHUB}/edit/main/docs/releases/${v}.md`, sidebar: { order: n } }, rewrite(body, src, "en", ctx));
	});
	console.log(`synced: how-it-works ${Object.keys(plans).join("+")} (${plans.en.pages.length + 1} pages each), ${versions.length} releases`);
}

process.exit(process.argv.includes("--check") ? check() : (sync(), 0));
