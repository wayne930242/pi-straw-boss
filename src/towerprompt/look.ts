// How the tower prompt looks (docs/how-it-works.md, The standing pane): the glyphs, the colours, and the clear of the screen. The prompt (prompt.ts) says what is shown; this says how it is drawn.
// Plain Node and no pi package, like the rest of towerprompt/: cli.mjs runs under plain node.

/** The three switches of the look. */
export interface Look {
	/** SGR styles (bold, dim, colours). */
	color: boolean;
	/** Nothing outside ASCII is drawn, and the tower glyph gives way to the word `tower`. */
	ascii: boolean;
	/** The pane's screen is cleared when the prompt shows its first state, so the command the server typed does not stay on it. */
	clear: boolean;
}

/** What a pipe, a log, or a test gets: ASCII, no style, no escape. */
export const PLAIN: Look = { color: false, ascii: true, clear: false };

const on = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value ?? "");
const off = (value: string | undefined) => /^(0|false|no|off)$/i.test(value ?? "");

/**
 * The look from the boss's environment. A terminal gets the glyphs (the tower's tab label is a Nerd Font glyph already), the colours, and the clear. `NO_COLOR` set to anything but empty (no-color.org) takes the colours
 * and leaves the rest; `STRAW_BOSS_ASCII=1` takes every glyph outside ASCII; `TERM=dumb` takes colours and clear. With no terminal the look is plain, unless `STRAW_BOSS_ASCII=0` asks for the glyphs.
 */
export function lookOf(env: NodeJS.ProcessEnv, terminal: boolean): Look {
	const ascii = on(env.STRAW_BOSS_ASCII) || (!terminal && !off(env.STRAW_BOSS_ASCII));
	if (!terminal) return { color: false, ascii, clear: false };
	const dumb = env.TERM === "dumb";
	return { color: !dumb && !env.NO_COLOR, ascii, clear: !dumb };
}

/** The radio tower glyph of the tower's tab (Nerd Font md-radio_tower), and the crown of the head tower's (md-crown). */
const TOWER = "\u{F043B}";
const CROWN = "\u{F01A5}";
const RESET = "\x1b[0m";
/** Clears the visible screen and homes the cursor; the scrollback stays (the last run's output is still there to scroll to). */
export const CLEAR = "\x1b[H\x1b[2J";

type Style = "bold" | "dim" | "accent" | "ok" | "warn" | "bad" | "run";
const SGR: Record<Style, string> = { bold: "1", dim: "2", accent: "36", ok: "32", warn: "33", bad: "31", run: "34;1" };

/** What a line between the states is about: it picks the glyph and the colour. */
export type Kind = "info" | "ok" | "warn" | "bad" | "ask";
const KINDS: Record<Kind, { glyph: string; ascii: string; style: Style }> = {
	info: { glyph: "◐", ascii: "*", style: "accent" },
	ok: { glyph: "✓", ascii: "+", style: "ok" },
	warn: { glyph: "!", ascii: "!", style: "warn" },
	bad: { glyph: "✗", ascii: "x", style: "bad" },
	ask: { glyph: "?", ascii: "?", style: "warn" },
};
/** The glyph before the line that says the boss left (it is no trouble, so it is dim). */
const LEAVE = { glyph: "↩", ascii: "<" };

const STATES: Record<string, { glyph: string; ascii: string; style: Style }> = {
	standing: { glyph: "●", ascii: "o", style: "ok" },
	waking: { glyph: "◐", ascii: "~", style: "warn" },
	running: { glyph: "▶", ascii: ">", style: "run" },
	closing: { glyph: "◑", ascii: "~", style: "warn" },
	held: { glyph: "■", ascii: "!", style: "bad" },
};
const UNKNOWN_STATE = { glyph: "●", ascii: "?", style: "dim" as Style };

/** A row of the hints: the keys that do it (a symbol form and an ASCII form) and what it does. */
export interface Hint {
	keys: string;
	plain: string;
	text: string;
}

/** How many terminal columns a text takes: a CJK character takes two. */
const cells = (text: string) => [...text].reduce((n, ch) => n + (ch.codePointAt(0)! >= 0x2e80 ? 2 : 1), 0);

/** The pieces of the screen, drawn in a look. */
export function draw(look: Look) {
	const paint = (style: Style[], text: string) => (look.color && text ? `\x1b[${style.map((s) => SGR[s]).join(";")}m${text}${RESET}` : text);
	const mark = (glyph: string, ascii: string) => (look.ascii ? ascii : glyph);
	return {
		/** `󰐻 tower · Alpha`, bold; the head tower's title carries the crown. */
		title: (text: string, head = false) => `${paint(["accent"], mark(head ? CROWN : TOWER, "#"))} ${paint(["bold"], look.ascii ? text.replace(" · ", " - ") : text)}`,
		/** `● standing by`: the dot in the colour of the state, the words dim for a tower that stands by and plain otherwise. */
		state: (state: string, words: string) => {
			const s = (Object.hasOwn(STATES, state) ? STATES[state] : undefined) ?? UNKNOWN_STATE;
			return `${paint([s.style], mark(s.glyph, s.ascii))} ${state === "standing" ? paint(["dim"], words) : words}`;
		},
		/** A line between the states. */
		note: (kind: Kind, text: string) => {
			const k = KINDS[kind];
			return `${paint([k.style], mark(k.glyph, k.ascii))} ${text}`;
		},
		/** The line that says the boss took the pane. */
		leave: (text: string) => `${paint(["dim"], mark(LEAVE.glyph, LEAVE.ascii))} ${paint(["dim"], text)}`,
		/** The key rows under the state, the keys in the accent colour and in one column, the words dim. */
		hints: (rows: Hint[]): string[] => {
			const keys = rows.map((r) => (look.ascii ? r.plain : r.keys)), width = Math.max(...keys.map(cells));
			return rows.map((r, i) => `  ${paint(["accent"], keys[i]!)}${" ".repeat(width - cells(keys[i]!))}  ${paint(["dim"], r.text)}`);
		},
		/** The string readline writes before the line the boss types. */
		prompt: () => (look.ascii ? "tower> " : paint(["accent", "bold"], `${TOWER} ❯ `)),
		/** The prompt string of the pick mode (`wait ❯`; `wait> ` in ASCII, whatever the language: nothing outside ASCII is drawn). */
		pickPrompt: (word: string) => (look.ascii ? "wait> " : paint(["accent", "bold"], `${word} ❯ `)),
		/** The prompt string of a field of the card view (`原因 ❯`; in ASCII its English word, `reason> `). */
		fieldPrompt: (word: string, plain: string) => (look.ascii ? `${plain}> ` : paint(["accent", "bold"], `${word} ❯ `)),
		/** The mark before the row the boss has marked in the card view. */
		pointer: () => (look.ascii ? ">" : "❯"),
		/** A row of the card view: the marked one in the accent colour, the key hint dim. */
		row: (text: string, kind: "marked" | "plain" | "hint") => (kind === "marked" ? paint(["accent", "bold"], text) : kind === "hint" ? paint(["dim"], text) : text),
	};
}
