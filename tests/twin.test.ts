import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { brokenBold, twinDrift, twinProblems } from "../site/scripts/twin.mjs";

// The zh-TW twin of docs/how-it-works.md (AGENTS.md, Docs): the checks that fail `npm --prefix site run check`, and so block the Pages build, run
// here too, so a twin that no longer matches line for line fails `npm test` before a push rather than only in the Pages workflow. Translation drift
// (English commits not yet translated) is a warning there and is not checked here.

const REPO = fileURLToPath(new URL("..", import.meta.url));

test("the zh-TW twin matches docs/how-it-works.md line for line, in its headings, and in bold the pages can show", () => {
	assert.deepEqual(twinProblems(REPO), []);
});

test("the twin check catches what blocks Pages: a line count, a line's kind, a missing backticked token, and bold beside CJK punctuation", () => {
	assert.deepEqual(twinDrift(["a", "b"], ["a"]), { message: "2 lines in English, 1 in zh-TW" });
	assert.deepEqual(twinDrift(["# T", "- `x` y", "text `a`"], ["# 題", "`x` 乙", "文字 `a` `b`"]), { bad: [2] }, "a bullet turned text");
	assert.deepEqual(twinDrift(["uses `call_tower`"], ["用 call_tower"]), { bad: [1] }, "a token left out");
	assert.deepEqual(twinDrift(["```", "`a` code", "```"], ["```", "程式", "```"]), { bad: [] }, "code lines are not compared");
	assert.deepEqual(brokenBold("**粗體**。\n這是**「引號」**的字"), [2]);
});
