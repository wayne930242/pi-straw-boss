// A small reader of gui/style.css for the tests that guard its rules (no browser runs here): the rules as [selector, declarations], at-rules that
// nest rules (@media, @supports) read through, @keyframes and @font-face left out, comments stripped.

export interface Rule {
	selector: string;
	/** The selector's comma-separated parts, each with its whitespace collapsed. */
	parts: string[];
	body: string;
}

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
/** The top-level pieces of `text` split at `sep`, ignoring a separator inside parentheses, brackets, or quotes. */
export function split(text: string, sep: string): string[] {
	const out: string[] = [];
	let depth = 0, quote = "", from = 0;
	for (let at = 0; at < text.length; at++) {
		const ch = text[at]!;
		if (quote) quote = ch === quote ? "" : quote;
		else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "(" || ch === "[") depth++;
		else if (ch === ")" || ch === "]") depth--;
		else if (ch === sep && depth === 0) (out.push(text.slice(from, at)), (from = at + 1));
	}
	out.push(text.slice(from));
	return out;
}

interface SheetRule { prelude: string; body?: string }

/** Immediate children of a sheet or grouping rule. A statement ends at `;` and has no body. */
export function* sheetRules(source: string): Generator<SheetRule> {
	const text = strip(source);
	let start = 0, open = 0, depth = 0, parens = 0, quote = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (ch === "\\") i++;
		else if (quote) { if (ch === quote) quote = ""; }
		else if (ch === "\"" || ch === "'") quote = ch;
		else if (ch === "(" || ch === "[") parens++;
		else if (ch === ")" || ch === "]") parens--;
		else if (!parens && ch === "{" && depth++ === 0) open = i;
		else if (!parens && ch === "}" && --depth === 0) {
			yield { prelude: text.slice(start, open).trim(), body: text.slice(open + 1, i) };
			start = i + 1;
		} else if (!parens && !depth && ch === ";") {
			yield { prelude: text.slice(start, i).trim() };
			start = i + 1;
		}
	}
}

export function rulesOf(source: string): Rule[] {
	const out: Rule[] = [];
	for (const { prelude, body } of sheetRules(source)) {
		if (body === undefined) continue;
		if (/^@(media|supports|layer)\b/.test(prelude)) out.push(...rulesOf(body));
		else if (!prelude.startsWith("@")) out.push({ selector: prelude, parts: split(prelude, ",").map((s) => s.trim().replace(/\s+/g, " ")), body });
	}
	return out;
}

/** A rule's declarations as [property, value]. */
export const declarations = (body: string): [string, string][] =>
	split(body, ";").flatMap((d) => {
		const colon = d.indexOf(":");
		return colon < 0 ? [] : [[d.slice(0, colon).trim(), d.slice(colon + 1).trim()] as [string, string]];
	});

// WCAG 2.x contrast, for #rrggbb colours.
const channels = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const linear = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
	const [r, g, b] = channels(hex).map(linear) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string) => {
	const x = luminance(a), y = luminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** `color` painted at `share` (0 to 1) over `under`, as `color-mix(in srgb, color share, under)` does. */
export const mix = (color: string, share: number, under: string) =>
	`#${channels(color).map((v, i) => Math.round(v * share + channels(under)[i]! * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
