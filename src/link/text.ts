// Text a remote sender controls, as it may appear in a line a local model reads (docs/specs/2026-10-25-straw-link.md, Header; review R-F029).

/** A label's length limit (src/link/device.ts `labelOk`): the same limit holds for any sender-controlled field of a header. */
export const FIELD_MAX = 40;
const OUTSIDE = /[^A-Za-z0-9 ._-]/g;

/**
 * `text` restricted to the label character set (ASCII letters, digits, space, `.`, `_`, `-`; anything else becomes `_`) and to 40 characters,
 * with no space at either end. Never empty: `?` stands in. A header quotes the result, but it has no character left to break a field with.
 */
export function restrictLabel(text: string): string {
	const cut = text.replace(OUTSIDE, "_").trim().slice(0, FIELD_MAX).trim();
	return cut || "?";
}
