import { clearLine, createInterface, cursorTo, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { createCardView } from "./cardview.ts";
import { CLEAR, draw, type Look, lookOf, PLAIN } from "./look.ts";
import { type Locale, textsFor } from "./messages.ts";
import { createPick } from "./pick.ts";
import { waitBlock } from "./waitblock.ts";
import { dialogLines, entryLine, shown as shownLine } from "./entry.ts";
import type { PollAnswer, PromptSource } from "./source.ts";

// The screen of the tower prompt (docs/how-it-works.md, The standing pane): a title, the tower's state on one line, key rows as the hint, and a line to write at the styled prompt (`tower> ` in ASCII; look.ts draws them). It polls its source for the state and for the order to
// leave, posts what the boss writes as a `boss` event, and ends in one of three ways: a run is starting (the server starts it in this pane; what the boss has typed since goes to the tower first), the boss
// pressed Ctrl+D or Ctrl+C (the pane is theirs, the server is told), or the server stands in for no tower here any more. Every exit is 0: what the shell does next is not an error. A line the boss wrote does
// not end the prompt: the run starts about a second later, and keys typed in that second would land in the shell's line, where the start of the run's pi types over them (B6 VM round 2: the first start timed out).
// The prompt stays, polling fast, and holds what is typed until the order to leave.
// It is plain readline on purpose: cli.mjs runs under plain node, where pi's own packages (pi-tui) are not on disk, and scripts/build-server.mjs fails the bundle that imports one. A fuller screen (the net's rows, the
// board) goes through the same two seams, the PromptSource and the injected streams, but needs its own way to draw.

const POLL_MS = 2000;
/** After the boss wrote, how often the prompt asks whether the run starts: for as long as the server shows a wake pending (events queued, or a run waking), however long the start takes (a Windows claim took 10 to 46 s). */
const WAKING_POLL_MS = 250;
/** The server needs this long after a post to show it as queued before a standing, empty tower ends the fast asking. */
const WAKING_GRACE_MS = 3000;
/** The longest the prompt asks fast for one post: past a claim that took 46 s, a wake that has not started is not coming soon (a settings refusal keeps the queue and the standing state). */
const WAKING_MAX_MS = 90_000;
/** Lines that arrive this close together are one paste, one message. */
const PASTE_MS = 40;
/** A bracketed paste that has not ended (its end marker was lost, or its start was a stray escape) is closed after this long with no new paste data: Ctrl+C and Ctrl+D never wait for it, and nothing stays held for ever (RV16-F002). */
const PASTE_CAP_MS = 2000;
/** What a terminal that has bracketed paste on sends around a paste; readline reports them as the keys `paste-start` and `paste-end`. */
const PASTE_START = "paste-start", PASTE_END = "paste-end";
/** What a message with no words says to the tower. */
export const NO_MESSAGE = "The boss is at the keyboard in the tower's pane and woke it without a message. They will write in this run's session if they have something to say.";

export interface PromptOptions {
	workspace: string;
	source: PromptSource;
	input: Readable;
	output: Writable;
	locale: Locale;
	/** How it is drawn (look.ts). A look that asks for style or the clear is held to a terminal: a pipe never gets an escape. */
	look?: Look;
	/** The boss's environment, which `lookOf` reads when no `look` is given; with neither the look is plain ASCII with no style. */
	env?: NodeJS.ProcessEnv;
	pollMs?: number;
	/** How often it asks while a wake is pending (tests set it); `WAKING_POLL_MS` by default. */
	wakingPollMs?: number;
	/** Ends the prompt as a run's start does (the pane is closing, the process is told to end). */
	signal?: AbortSignal;
	/** How long a bracketed paste may go without new data before it counts as ended (tests set it); `PASTE_CAP_MS` by default. */
	pasteCapMs?: number;
	/** The clock of the polling (tests set it): the time of a post and the timer of the next poll. The real clock by default. */
	clock?: PromptClock;
	/** The platform the prompt runs on (tests set it): on win32 the card view is off and the numbered picker stays, until its console's keys and pastes are checked there. */
	platform?: NodeJS.Platform;
	/** How long readline waits after a lone Escape byte for the rest of a key's sequence (tests set it); readline's own 500 ms by default. */
	escapeMs?: number;
}
/** What `after` returns: the clock's own timer, given back to `cancel`. */
type ClockHandle = object;
export interface PromptClock {
	now(): number;
	after(fn: () => void, ms: number): ClockHandle;
	cancel(handle: ClockHandle): void;
}
const REAL_CLOCK: PromptClock = { now: () => Date.now(), after: (fn, ms) => setTimeout(fn, ms), cancel: (handle) => clearTimeout(handle as NodeJS.Timeout) };

/** Nothing the server sends reaches the terminal as a control sequence. */
const clean = (value: unknown, max = 200) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, max);

/** One key: one code point, or one complete escape sequence (CSI such as an arrow, SS3, or Alt plus a key). */
const isOneKey = (decoded: string) => [...decoded].length === 1 || /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|.)$/su.test(decoded);

/** How many bytes at the end of `bytes` are the start of a UTF-8 character that the read did not finish. */
const openTail = (bytes: Buffer): number => {
	for (let i = bytes.length - 1; i >= 0 && i >= bytes.length - 3; i--) {
		const b = bytes[i]!;
		if ((b & 0xc0) === 0x80) continue;
		const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
		return bytes.length - i < need ? bytes.length - i : 0;
	}
	return 0;
};

/** A batch of one line that starts with `/` (and not `//`) is for the prompt, never the tower. */
const commandOf = (lines: string[]): string | undefined => {
	const [only] = lines;
	return lines.length === 1 && only !== undefined && only.startsWith("/") && !only.startsWith("//") ? only.trim() : undefined;
};

/** Runs the prompt until it ends; resolves the exit code. */
export async function runPrompt(o: PromptOptions): Promise<number> {
	const clock = o.clock ?? REAL_CLOCK, text = textsFor(o.locale), pollMs = o.pollMs ?? POLL_MS, wakingMs = Math.min(pollMs, o.wakingPollMs ?? WAKING_POLL_MS), source = o.source;
	const terminal = (o.output as Partial<NodeJS.WriteStream>).isTTY === true;
	const look = o.look ?? (o.env ? lookOf(o.env, terminal) : PLAIN), d = draw({ ...look, color: look.color && terminal, clear: look.clear && terminal });
	let begun = false, shownDialogs = "", lastAnswer: PollAnswer | undefined;
	// The rows of the card view (cardview.ts) as drawn last, while they stand right above the message line: a line said meanwhile goes above them, and a row that changes is drawn over them. An Enter (its echo is a line of its own) ends that.
	let region: string[] = [];
	// What the input's last read was, seen before readline had it: one typed key and no part of a paste (`lone`), and the message line as it was before that key.
	let lone = false, lineBefore = "";
	// The polls: one is on its way, and the next comes at once after it (the card view said the boss is done). The card view reads the cards only once the message line is there (`ready`).
	let polling = false, again = false, ready = false, syncFirst = false;
	// An Enter came while the card view was opening the pane's mark: it was typed before the pane was this computer's alone (a paired phone's key pad could have sent it), so the view presses nothing with it.
	let early = false;
	// The block of cards that wait for the boss (waitblock.ts): printed when the digest of a poll changes, and a bracketed paste seen since the last flush (a paste is no pick).
	let shownWaits: string | undefined, sawPaste = false;
	let rl: Interface | undefined, closed = false, finished = false, posting = false, silent = false, shown: string | undefined, shownLabel: string | undefined, wokeAt: number | undefined;
	let timer: object | undefined, batch: string[] = [], batchTimer: ReturnType<typeof setTimeout> | undefined, pasteTimer: ReturnType<typeof setTimeout> | undefined, pasting = false;
	// Input chunks grouped, and the group the last line came in: a paste is one group however many reads carry it, typed keys are groups of their own (RV16-F003, RV17-F001, RV17-F002).
	let chunks = 0, lineChunk = 0, lastDataAt = -Infinity;
	const pasteCapMs = o.pasteCapMs ?? PASTE_CAP_MS;
	let finish!: (code: number) => void;
	const done = new Promise<number>((resolve) => (finish = resolve));
	// The picker of the wait cards (pick.ts): `/wait` takes the keyboard until it ends; its lines are never the boss's words.
	const pick = createPick({
		source: source.pick, locale: o.locale, now: () => clock.now(),
		say: (line, kind = "plain") => say(kind === "plain" ? line : d.note(kind, line)),
		mode: (on) => {
			rl?.setPrompt(on ? d.pickPrompt(text.pickWord) : d.prompt());
			if (terminal && rl && !closed && !finished) rl.prompt(true);
		},
	});

	/**
	 * A line of its own. On a terminal it replaces the line the cursor is on (the prompt and what the boss typed, which `again` draws back below it); a line that ends the prompt asks for no prompt again,
	 * and none is drawn on an interface that was closed (Ctrl+D closes it before this runs: a prompt on it throws ERR_USE_AFTER_CLOSE, which a pane showed and a test with no terminal did not).
	 */
	const say = (line: string, again = true) => {
		const live = again && terminal && rl !== undefined && !closed && !finished;
		// The card view's rows stand above the message line: the line goes above them, so they stay where a key draws them again. Not while what the boss typed takes more than one terminal line (the cursor is then not on the prompt's own).
		if (live && region.length && rl!.getCursorPos().rows === 0) {
			o.output.write(`\x1b[${region.length}A\r\x1b[2K${line}\n${region.map((l) => `\x1b[2K${l}\n`).join("")}`);
			return rl!.prompt(true);
		}
		region = [];
		if (terminal) {
			cursorTo(o.output, 0);
			clearLine(o.output, 0);
		}
		o.output.write(`${line}\n`);
		if (live) rl!.prompt(true);
	};
	/** The card view's rows: over the ones drawn last when they still stand above the message line and are as many (the cursor goes up over them, each is written again, and the line is drawn under them), else as new lines. As for a line said: not while what the boss typed takes more than one terminal line. */
	const drawRows = (lines: string[]) => {
		if (!lines.length) return void (region = []);
		if (region.length === lines.length && rl && !closed && !finished && rl.getCursorPos().rows === 0) {
			o.output.write(`\x1b[${lines.length}A\r${lines.map((l) => `\x1b[2K${l}\n`).join("")}`);
			rl.prompt(true);
		} else {
			region = [];
			for (const line of lines) say(line);
		}
		region = terminal && rl && !closed && !finished ? lines : [];
	};
	/** The next poll comes now: the card view said the boss stopped answering, and the server's hold of the wake ends with the poll that says so. */
	const soon = () => {
		if (finished) return;
		if (polling) return void (again = true);
		if (timer) clock.cancel(timer);
		timer = clock.after(() => void poll(), 0);
	};
	// The card view (cardview.ts): where the terminal reports keys, the open wait cards are drawn one after another and answered with the arrows, a digit, and Enter, with no command typed. A pipe, TERM=dumb, and Windows (until its console's
	// keys and pastes are checked) keep the block and the numbered picker.
	const keys = terminal && (o.input as Partial<NodeJS.ReadStream>).isTTY === true && o.env?.TERM !== "dumb" && (o.platform ?? process.platform) !== "win32";
	const cards = keys && source.pick ? createCardView({
		source: source.pick, locale: o.locale, ascii: look.ascii, pointer: d.pointer(), paint: d.row, now: () => clock.now(), columns: () => (o.output as Partial<NodeJS.WriteStream>).columns ?? 80,
		say: (line, kind = "plain") => say(kind === "plain" ? line : d.note(kind, line)),
		rows: drawRows,
		fresh: () => void (region = []),
		field: (f) => {
			if (!rl || closed || finished) return;
			rl.setPrompt(f ? d.fieldPrompt(f.word, f.plain) : d.prompt());
			// What a field left on the line is not the boss's words to the tower: the line is emptied, from its end.
			if (!f && rl.line !== "") (rl.write(null, { ctrl: true, name: "e" }), rl.write(null, { ctrl: true, name: "u" }));
			rl.prompt(true);
		},
		idle: soon,
	}) : undefined;
	/** The first thing on the pane: its screen is cleared, so the command the server typed to start this prompt does not stay on it. Not before there is something to show (a run that is already starting needs no clear). */
	const begin = () => {
		if (begun) return;
		begun = true;
		if (look.clear && terminal) o.output.write(CLEAR);
	};
	/** Ends the prompt: what the server is told goes first, within the source's own time limit. */
	const end = async (after: () => Promise<void>) => {
		if (finished) return;
		finished = true;
		if (timer) clock.cancel(timer);
		clearTimeout(batchTimer);
		clearTimeout(pasteTimer);
		rl?.close();
		try {
			await pick.stop();
			await cards?.stop();
			await after();
		} catch {
			// The server may be gone: the prompt ends all the same.
		}
		finish(0);
	};
	const lineOf = (a: PollAnswer) => ({ state: clean(a.state), words: `${text.state({ state: clean(a.state) as PollAnswer["state"], queued: Number.isFinite(a.queued) ? a.queued : 0 })}${a.holding === true ? text.holding : ""}` });

	/** What one poll does to the screen; returns whether the prompt goes on. */
	const handle = async (polled: Awaited<ReturnType<PromptSource["poll"]>>): Promise<boolean> => {
		if (polled.kind === "gone") {
			say(d.note("warn", text.noTower), false);
			await end(async () => {});
			return false;
		}
		if (polled.kind === "wait") {
			if (!silent) {
				begin();
				say(d.note("warn", text.silent(clean(polled.why))));
			}
			silent = true;
			return true;
		}
		if (silent) say(d.note("ok", text.back));
		silent = false;
		if (polled.answer.leave) {
			// The boss's line is on its way (the post ends the prompt, or refuses and the prompt goes on).
			if (posting) return true;
			// A press the boss already sent is answered first: its result is printed before the pane is given up (the press queues the wake, and the order to leave waits a second).
			// The same holds at the card view while the boss is at its keys: the press is answered first, and what is on the line (the text of a field) is dropped.
			const picking = pick.active() || (cards?.engaged() ?? false);
			if (pick.active()) await pick.whenIdle();
			await cards?.whenIdle();
			// A run is starting in this pane while the boss is typing: their words are for the tower, and the pane is a shell in a moment, where they must not land. What they entered (the paste window) and what is on the line go first.
			const entered = [...batch, rl?.line ?? ""];
			if (entered.at(-1) === "" && entered.length > 1) entered.pop();
			// The batch rule of `flush` holds here too: a lone `/` line (`/quit`, `/new`, `/reload` typed a moment before the order came) is a command or refused, never the boss's words (RV11-F002). The pane is leaving, so there is nothing to start over or quit.
			// Digits typed to pick a card are never the boss's words: in pick mode what is on the line is dropped, and the prompt says where the cards are now.
			const words = picking || commandOf(entered) !== undefined ? "" : entered.join("\n").trim();
			// The boss wrote a while ago and the prompt said so then: the line is only cleared.
			if (picking) say(d.note("info", text.pickWoke), false);
			else if (wokeAt === undefined) say(d.note("info", text.waking), false);
			else if (terminal) {
				cursorTo(o.output, 0);
				clearLine(o.output, 0);
			}
			await end(async () => {
				if (words) {
					try {
						await source.post(words);
					} catch (cause) {
						o.output.write(`${d.note("bad", text.refused(clean((cause as Error).message, 400)))}\n${words.split("\n").map((l) => clean(l, 2000)).join("\n")}\n`);
					}
				}
				await source.gone();
			});
			return false;
		}
		// The boss wrote and the run has not taken the pane: the order to leave comes with its start, so the prompt asks fast until then. A tower that stands by with nothing queued, a moment after the post, has no wake pending.
		// A held service starts no run, and a wake that is not seen to start within the cap is not asked for fast for ever.
		if (wokeAt !== undefined && ((polled.answer.state === "standing" && polled.answer.queued === 0 && clock.now() - wokeAt > WAKING_GRACE_MS) || polled.answer.state === "held" || clock.now() - wokeAt > WAKING_MAX_MS)) wokeAt = undefined;
		const label = clean(polled.answer.label), now = lineOf(polled.answer);
		begin();
		// Headless runs: the live transcript above the input line, and a run's dialogs when they change (entry.ts).
		lastAnswer = polled.answer;
		for (const l of polled.answer.lines ?? []) say(shownLine(l));
		const dl = dialogLines(polled.answer, o.locale, shownDialogs);
		shownDialogs = dl.key;
		dl.lines.forEach((l, i) => say(i === 0 ? d.note("ask", l) : l));
		// The title when the label is new (the first look, or a tower renamed), the state line when it changed.
		if (label !== shownLabel) {
			shownLabel = label;
			say(d.title(polled.answer.head ? text.head : text.title(label), polled.answer.head === true));
		}
		const line = `${now.state}\n${now.words}`;
		if (line !== shown) {
			shown = line;
			say(d.state(now.state, now.words));
		}
		// The block of waiting cards, printed again only when its digest changes (and never over the picker); it makes no bell.
		// The head's viewer also reads again when another tower's card comes or goes (`elsewhere`, headless runs): its card view lists every tower's, its own first.
		const waits = Array.isArray(polled.answer.waits) ? polled.answer.waits : [], key = JSON.stringify(waits), all = polled.answer.elsewhere?.length ? JSON.stringify([waits, polled.answer.elsewhere]) : key;
		cards?.attend(polled.answer.unattended !== true);
		// Where the card view shows the cards, it reads them when the digest changes, and at every poll while the boss answers (a card of another tower is not in this digest).
		if (cards?.shows()) {
			if (all !== shownWaits || cards.engaged()) {
				shownWaits = all;
				if (ready) void cards.sync();
				else syncFirst = true;
			}
		} else if (key !== shownWaits && !pick.active()) {
			const first = shownWaits === undefined;
			shownWaits = key;
			if (waits.length) waitBlock(waits, o.locale, "/wait").forEach((l, i) => say(i === 0 ? d.note("ask", l) : l));
			else if (!first) say(d.note("info", text.waitsNone));
		}
		return true;
	};
	const poll = async () => {
		if (finished) return;
		polling = true;
		try {
			const polled = await source.poll(cards?.answering() ?? false, Boolean(rl && !closed && ((rl.line ?? "") !== "" || batch.length || pasting || posting || pick.active() || cards?.engaged()))).catch((cause: Error) => ({ kind: "wait" as const, why: cause.message }));
			if (finished || !(await handle(polled))) return;
		} finally {
			polling = false;
		}
		timer = clock.after(() => void poll(), again ? 0 : nextPoll());
		again = false;
	};
	/** Fast while a wake is pending: the run starts in about a second, and the prompt must be told to leave then, not seconds later. */
	const nextPoll = () => (wokeAt !== undefined ? wakingMs : pollMs);

	/** The boss wrote: what arrived together is one message; an empty one wakes the tower without words. */
	const flush = async () => {
		const lines = batch;
		batch = [];
		// In pick mode the lines are the picker's, and never the tower's. A paste (a bracketed one, or more than one line together) is no pick: the mode ends with nothing pressed or posted.
		const pasted = sawPaste || lines.length > 1;
		sawPaste = false;
		if (pick.active()) return void (pasted ? await pick.paste() : await pick.line(lines[0] ?? ""));
		// At the card view, Enter presses the marked row and ends a field; with no row marked the line is the boss's, as below.
		const wasEarly = early;
		early = false;
		if (cards && (await cards.entered(lines, pasted, wasEarly))) return;
		if (finished) return;
		// A batch of one line that starts with `/` is for the prompt, never the tower (a `/reload` typed from habit is no message): `/new` alone starts a new boss session, `/quit` alone leaves the pane to the shell
		// as Ctrl+D does, and any other is refused with what the prompt takes. `//` at the start, or a space before the `/`, keeps the line a message (posted as typed; the space is trimmed with the rest of the message's
		// edges). A paste of several lines is one message whatever its first line is, and its `/` lines are never obeyed (a log that starts with a path, a file list with `/quit` in it).
		const word = commandOf(lines);
		if (!pasted && lines.length === 1) {
			let said: string | undefined;
			try {
				said = await entryLine(lines[0]!, { source, answer: lastAnswer, locale: o.locale });
			} catch (cause) {
				return void say(d.note("bad", text.refused(clean((cause as Error).message, 400))));
			}
			if (said !== undefined) return void say(d.note("info", said));
		}
		if (word !== undefined) {
			if (word === "/new") return void (await startOver());
			if (word === "/quit") return leave();
			if (/^\/(?:boss )?wait$/.test(word.replace(/\s+/g, " "))) return void (cards ? await cards.focus() : await pick.start());
			return void say(d.note("ask", text.unknownCommand(clean(word.split(/\s+/)[0], 40))));
		}
		const message = lines.join("\n").trim() || NO_MESSAGE;
		// The boss writes to the tower: they are no longer at the cards, and the run this wakes is not held.
		void cards?.wrote();
		posting = true;
		try {
			await source.post(message);
		} catch (cause) {
			posting = false;
			if (finished) return; // the boss left while the post was on its way
			say(d.note("bad", text.refused(clean((cause as Error).message, 400))));
			if (!terminal) rl?.prompt(); // a terminal drew it already, with what the boss typed
			return;
		}
		// The prompt stays (see the top): the order to leave comes with the run's start, and what the boss types meanwhile is held in the line and posted then.
		posting = false;
		if (finished) return;
		wokeAt = clock.now();
		if (timer) clock.cancel(timer);
		timer = clock.after(() => void poll(), nextPoll());
		say(d.note("info", text.waking));
		if (!terminal) rl?.prompt();
	};

	const startOver = async () => {
		try {
			await source.fresh();
			say(d.note("ok", text.fresh));
		} catch (cause) {
			say(d.note("bad", text.refused(clean((cause as Error).message, 400))));
		}
	};

	o.signal?.addEventListener("abort", () => void end(() => source.gone()), { once: true });
	// The first look comes before the screen: a tower that is gone, or a run that is already starting, needs no prompt.
	const first = await source.poll().catch((cause: Error) => ({ kind: "wait" as const, why: cause.message }));
	if (!(await handle(first))) return done;
	for (const line of d.hints(text.hints)) o.output.write(`${line}\n`);
	o.output.write("\n");
	// Counted before readline reads the chunk, so the lines it makes from it are in the chunk's count.
	// A read is a typed key when it is one code point or one complete escape sequence (an arrow, Alt+b), however many bytes that takes, and not a piece of a character split across reads (its bytes are carried to the
	// next read, so a split character is never a key). A read joins the group before it when a bracketed paste is open (up to its end marker, which is in the read that ends it), or when it follows the one before
	// within the paste window and is more than one key; a typed key joins only when the last read left a line unfinished (the last characters of a paste, alone in a read). So a typed `/quit⏎` and a key typed after
	// it, even a few ms later, are two groups (RV16-F003, RV18-F001), and a paste split by the pty into reads is one (RV17-F001, RV17-F002, RV18-F003).
	let carry = Buffer.alloc(0), unfinished = false;
	o.input.on("data", (data: string | Buffer) => {
		const at = clock.now();
		let decoded: string, continuing = false, open = false;
		if (typeof data === "string") decoded = data;
		else {
			const bytes = Buffer.concat([carry, data]), cut = bytes.length - openTail(bytes);
			continuing = carry.length > 0;
			open = cut < bytes.length;
			decoded = bytes.subarray(0, cut).toString("utf8");
			carry = bytes.subarray(cut);
		}
		const typed = !continuing && !open && isOneKey(decoded), near = at - lastDataAt < PASTE_MS;
		const joins = pasting || (near && (typed ? unfinished : true));
		if (!joins) chunks++;
		if (decoded !== "") unfinished = typed && !joins ? false : !/[\r\n]$/.test(decoded);
		lone = typed && !joins;
		lineBefore = rl?.line ?? "";
		lastDataAt = at;
		if (pasting) armPasteCap();
	});
	rl = createInterface({ input: o.input, output: o.output, prompt: d.prompt(), terminal, ...(o.escapeMs !== undefined ? { escapeCodeTimeout: o.escapeMs } : {}) });
	/**
	 * The paste window closes: what was entered goes as one message. Two things keep it open (B6 VM round 3c, Windows PowerShell: a paste of three lines and the Enter sent a moment later were two messages): a bracketed
	 * paste that has not ended (the terminal says where it ends, however far apart its pieces arrive), and a line the boss is still writing after lines that arrived with it (a paste whose last line has no line end yet;
	 * the Enter that ends it comes later and joins the batch). The run's start does not wait for either: `handle` takes the batch and the line together.
	 * A line is held as part of a paste only when it came in the same group of input chunks as the line being written (a group: the reads of an open bracketed paste, and reads that follow within the paste window with
	 * more than one key each, and a single key after a read that left a line unfinished); a line typed on its own (`/quit⏎`) and a key typed after it are groups apart (RV16-F003, RV17-F001, RV17-F002). A paste that
	 * has not ended is closed `pasteCapMs` after its last data (RV16-F002). The prompt does not turn bracketed paste on (`ESC[?2004h`): the shell sets that mode for itself at each of its prompts, a prompt that is
	 * killed before it could turn it off would leave the boss's shell with a mode it did not ask for, and a Windows console that does not know the mode would show the sequence; the markers are honoured when the terminal
	 * sends them, and the cap and the chunk rule cover the pastes that come without.
	 */
	const armFlush = () => {
		clearTimeout(batchTimer);
		if (pasting) return;
		batchTimer = setTimeout(() => (batch.length && (rl?.line ?? "") !== "" && chunks === lineChunk ? undefined : void flush()), PASTE_MS);
	};
	const endPaste = () => {
		pasting = false;
		clearTimeout(pasteTimer);
		if (batch.length && !finished && !posting) armFlush();
	};
	const armPasteCap = () => {
		clearTimeout(pasteTimer);
		pasteTimer = setTimeout(endPaste, pasteCapMs);
	};
	// A terminal that changed its width may have wrapped the rows of the card view: they are not drawn over again.
	o.output.on("resize", () => void (region = []));
	rl.on("line", (raw) => {
		// The Enter's echo is a line of its own under the card view's rows: they are not drawn over again.
		region = [];
		if (finished || posting) return;
		if (cards?.opening()) early = true;
		batch.push(raw);
		lineChunk = chunks;
		armFlush();
	});
	// Only a terminal's readline reports keys; a piped input has no markers to honour.
	o.input.on("keypress", (_text: string | undefined, key?: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean }) => {
		if (finished || posting) return;
		if (key?.name === PASTE_START) {
			pasting = true;
			sawPaste = true;
			clearTimeout(batchTimer);
			armPasteCap();
		} else if (key?.name === PASTE_END) endPaste();
		else if (cards && !pick.active()) cardKey(key);
	});
	/**
	 * A key at the card view. This runs after readline has had the key (its listener is the older one). A key is the view's only when its read was that one typed key (never a part of a paste) and the message line was empty before it; what
	 * readline did with it on the line is then undone (an arrow up recalls the last message, a digit is written), so no card key is ever the boss's words. In a field the keys are text, and only Esc is the view's. Any other typed key
	 * that leaves text on the line is the boss writing to the tower: the view lets go of a marked row.
	 */
	const cardKey = (key: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean } | undefined) => {
		const line = () => rl?.line ?? "";
		// Ctrl+L clears the screen: the rows are gone from above the line.
		if (key?.ctrl && key.name === "l") region = [];
		// A lone Escape is reported with `meta` (readline's reading of the byte); any other key with Ctrl or Alt is none of the view's.
		const name = key?.name === "escape" ? "escape" : key?.ctrl || key?.meta ? "" : /^\d$/.test(key?.sequence ?? "") ? key!.sequence! : (key?.name ?? "");
		// Pasted input is never a card key, and it leaves a marked row as it is: the Enter that follows it ends the view with nothing pressed (cardview.ts `entered`).
		if (!lone || pasting) return;
		if (cards!.field()) return void (name === "escape" ? cards!.escape() : cards!.touch());
		if (lineBefore === "" && cards!.takes(name)) {
			if (name === "up" && line() !== "") rl!.write(null, { name: "down" });
			if (line() !== "") rl!.write(null, { ctrl: true, name: "u" });
			return void cards!.key(name);
		}
		if (line() !== "") void cards!.typed();
	};
	// Ctrl+D (the end of the input) and Ctrl+C both leave the pane to the boss: a prompt that came back at once would be in the way of whatever they wanted a shell for.
	// It always ends the prompt as a park, whatever is held: a paste or a line the boss has not sent is dropped with the pane (Ctrl+C cancels it, nothing is posted later), and a close of the input is the same end, since a
	// prompt that went on with dead input would be killed by the next Ctrl+C without the server being told (RV16-F001).
	const leave = () => {
		if (finished) return;
		batch = [];
		say(d.leave(text.leaving), false);
		void end(() => source.leave());
	};
	rl.on("close", () => void ((closed = true), leave()));
	rl.on("SIGINT", leave);
	rl.prompt();
	ready = true;
	if (syncFirst && !finished) void cards?.sync();
	if (!finished) timer = clock.after(() => void poll(), pollMs);
	return done;
}
