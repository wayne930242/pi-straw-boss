import assert from "node:assert/strict";
import { test } from "node:test";
import { inline, type N, parse } from "../gui/markdown.ts";

const tags = (nodes: N[]): string[] => nodes.flatMap((n) => (typeof n === "string" ? [] : [n.tag, ...tags(n.kids)]));
const links = (nodes: N[]): string[] => nodes.flatMap((n) => (typeof n === "string" ? [] : [...(n.tag === "a" ? [n.attrs!.href!] : []), ...links(n.kids)]));
const allText = (nodes: N[]): string => nodes.map((n) => (typeof n === "string" ? n : allText(n.kids))).join("");

test("raw HTML never becomes an element: it stays text, in paragraphs, inline code, and headings alike", () => {
	const tree = parse('<script>alert(1)</script>\n\n# <img src=x onerror=alert(1)>\n\n- <b>bold</b>\n\n`<div>`\n\n<a href="javascript:alert(1)">x</a>');
	assert.deepEqual([...new Set(tags(tree))].sort(), ["code", "h1", "li", "p", "ul"], "only markdown elements");
	assert.ok(allText(tree).includes("<script>alert(1)</script>") && allText(tree).includes("<img src=x onerror=alert(1)>"));
});

test("only http, https, and mailto links are links, with rel and target; other schemes stay as text", () => {
	const good = inline("[a](https://example.com/x?y=1) [b](http://example.com) [c](mailto:me@example.com) see https://example.com/auto.");
	assert.deepEqual(links(good), ["https://example.com/x?y=1", "http://example.com", "mailto:me@example.com", "https://example.com/auto."]);
	const anchor = good.find((n) => typeof n !== "string" && n.tag === "a") as Exclude<N, string>;
	assert.deepEqual(anchor.attrs, { href: "https://example.com/x?y=1", rel: "noopener noreferrer", target: "_blank" });
	for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "//evil.example", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "/relative"]) assert.deepEqual(links(inline(`[x](${bad})`)), [], bad);
	assert.ok(allText(inline("[x](javascript:alert(1))")).includes("javascript:alert(1)"), "the text is not lost");
});

test("fences keep their text untouched, with the language as a data attribute", () => {
	const [pre] = parse("```ts\nconst a = `x`;\n**not bold** <b>\n```\nafter");
	assert.deepEqual(pre, { tag: "pre", kids: [{ tag: "code", kids: ["const a = `x`;\n**not bold** <b>"], attrs: { "data-lang": "ts" } }], attrs: undefined });
	assert.equal(parse("```\nopen fence never closed").length, 1, "an unclosed fence runs to the end");
	assert.deepEqual(tags(parse("~~~\nx\n~~~")), ["pre", "code"]);
});

test("headings, rules, block quotes, lists (ordered, nested, task), and tables parse into their elements", () => {
	assert.deepEqual(tags(parse("# a\n## b\n###### c\n\n---\n\n> quoted\n> more")), ["h1", "h2", "h6", "hr", "blockquote", "p"]);
	const list = parse("- one\n  - nested\n- [x] done\n- [ ] todo\n\n1. first\n2) second");
	assert.deepEqual(tags(list).filter((t) => t !== "p"), ["ul", "li", "ul", "li", "li", "i", "li", "i", "ol", "li", "li"]);
	const checks = (nodes: N[]): string[] => nodes.flatMap((n) => (typeof n === "string" ? [] : [...(n.attrs?.class === "check" ? [n.attrs["data-done"]!] : []), ...checks(n.kids)]));
	assert.deepEqual(checks(list), ["true", "false"], "task items carry a check mark element, not a text glyph");
	assert.ok(allText(list).includes("done") && allText(list).includes("todo"));
	const table = parse("| a | b |\n|---|:-:|\n| 1 | **2** |\n| 3 | 4 |\n\nafter");
	assert.deepEqual(tags(table), ["table", "thead", "tr", "th", "th", "tbody", "tr", "td", "td", "strong", "tr", "td", "td", "p"]);
	assert.equal(tags(parse("a | b\nplain text")).join(), "p", "a pipe alone is not a table");
});

test("emphasis, strikethrough, and code spans nest; unmatched markers stay literal and long input stays fast", () => {
	assert.deepEqual(tags(inline("**bold _and em_** ~~gone~~ `co*de*`")), ["strong", "em", "del", "code"]);
	assert.equal(allText(inline("a * b * c _ d ** e")), "a * b * c _ d ** e");
	assert.equal(allText(inline("snake_case_name and 2*3*4")), "snake_case_name and 2*3*4".replace("*3*", "3"), "word-internal underscores are not emphasis");
	const started = performance.now();
	parse("**a ".repeat(30_000) + "\n\n" + "`x ".repeat(30_000) + "\n\n" + "[a](b ".repeat(20_000));
	assert.ok(performance.now() - started < 1000, "unmatched markers are bounded");
});
