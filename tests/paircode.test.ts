import assert from "node:assert/strict";
import { test } from "node:test";
import { cleaned, createTypedCodes, typedText } from "../src/paircode.ts";

const wide = (text: string) => [...text].map((c) => (c >= "!" && c <= "~" ? String.fromCodePoint(c.codePointAt(0)! + 0xfee0) : c)).join("");
const fresh = () => createTypedCodes(60_000, 16);

test("a code is shown as two groups of four with a space, never a hyphen", () => {
	const typed = fresh();
	for (let i = 0; i < 50; i++) assert.match(typed.issue(), /^[0-9A-HJKMNP-TV-Z]{4} [0-9A-HJKMNP-TV-Z]{4}$/);
});

test("what a phone keyboard types is read as the code: full-width letters and digits, any dash or space, invisible marks, case", () => {
	const typed = fresh();
	const [a, b] = ["ABCD", "EFGH"];
	assert.equal(cleaned(`${wide(a!)}－${wide(b!)}`), "ABCDEFGH");
	const forms = (code: string) => {
		const [x, y] = [code.slice(0, 4), code.slice(5)];
		const out = [code, `${x}${y}`, code.toLowerCase(), wide(code), wide(`${x}-${y}`), wide(`${x}${y}`).toLowerCase(), ` ${x} ${y} `];
		for (const gap of ["\u3000", "\u00a0", "\u2009", "\u200b", "\u00ad", "\ufeff", "\t", "\n"]) out.push(`${x}${gap}${y}`);
		for (const dash of ["-", "\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015", "\u2212", "\uff0d", "\ufe63", "\u058a"]) out.push(`${x}${dash}${y}`, `${x} ${dash} ${y}`);
		return out;
	};
	// Every form of a code, one fresh code each.
	for (let n = 0; n < forms("AAAA AAAA").length; n++) assert.equal(typed.take(forms(typed.issue())[n]!), "ok", `form ${n}: ${JSON.stringify(forms("ABCD EFGH")[n])}`);
});

test("the look-alikes I, L, and O are read as 1 and 0, also in full width", () => {
	const typed = fresh();
	let seen = 0;
	for (let i = 0; i < 400 && seen < 3; i++) {
		const code = typed.issue();
		if (!/[01]/.test(code)) continue;
		seen++;
		assert.equal(typed.take(wide(code.replace(/0/g, "o").replace(/1/g, "l"))), "ok", code);
	}
	assert.equal(seen, 3);
});

test("anything else is a wrong code, and the fifth wrong one locks", () => {
	const typed = fresh();
	const code = typed.issue();
	for (const wrong of ["", "ABCD", "AAAA AAAA AAAA", "UUUU UUUU"]) assert.equal(typed.take(wrong), "wrong", JSON.stringify(wrong));
	assert.equal(typed.take("中文中文中文中文"), "wrong", "the fifth voids every waiting code");
	assert.equal(typed.take(code), "locked");
	assert.equal(typed.take(`${code}${code}`), "locked");
});

test("the form's text is the single code field, or the eight boxes joined in order", () => {
	const form = (text: string) => new URLSearchParams(text);
	assert.equal(typedText(form("code=ABCD-EFGH")), "ABCD-EFGH");
	assert.equal(typedText(form("c1=A&c2=B&c3=C&c4=D&c5=E&c6=F&c7=G&c8=H")), "ABCDEFGH");
	assert.equal(typedText(form("c8=H&c7=G&c6=F&c5=E&c4=D&c3=C&c2=B&c1=A")), "ABCDEFGH", "by box number, not by order of arrival");
	assert.equal(typedText(form("code=&c1=A&c2=B&c3=C&c4=D&c5=E&c6=F&c7=G&c8=H")), "ABCDEFGH");
	assert.equal(typedText(form("code=ABCDEFGH&c1=Z")), "ABCDEFGH", "the single field wins");
	assert.equal(typedText(form("c1=A&c3=C")), "AC", "a missing box leaves a short, wrong code");
	assert.equal(typedText(form("")), "");
});
