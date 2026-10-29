import { clearLine, createInterface, cursorTo, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { type Locale, textsFor } from "./messages.ts";
import type { PollAnswer, PromptSource } from "./source.ts";

// The screen of the tower prompt (docs/how-it-works.md, The standing pane): the tower's state on one line, a hint, and a line to write at `tower> `. It polls its source for the state and for the order to
// leave, posts what the boss writes as a `boss` event, and ends in one of three ways: a run is starting (the server starts it in this pane; what the boss has typed since goes to the tower first), the boss
// pressed Ctrl+D or Ctrl+C (the pane is theirs, the server is told), or the server stands in for no tower here any more. Every exit is 0: what the shell does next is not an error. A line the boss wrote does
// not end the prompt: the run starts about a second later, and keys typed in that second would land in the shell's line, where the start of the run's pi types over them (B6 VM round 2: the first start timed out).
// The prompt stays, polling fast, and holds what is typed until the order to leave.
// It is plain readline on purpose: cli.mjs runs under plain node, where pi's own packages (pi-tui) are not on disk, and scripts/build-server.mjs fails the bundle that imports one. A fuller screen (the net's rows, the
// board) goes through the same two seams, the PromptSource and the injected streams, but needs its own way to draw.

export const PROMPT = "tower> ";
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
	pollMs?: number;
	/** How often it asks while a wake is pending (tests set it); `WAKING_POLL_MS` by default. */
	wakingPollMs?: number;
	/** Ends the prompt as a run's start does (the pane is closing, the process is told to end). */
	signal?: AbortSignal;
	/** How long a bracketed paste may go without new data before it counts as ended (tests set it); `PASTE_CAP_MS` by default. */
	pasteCapMs?: number;
	/** The clock of the polling (tests set it): the time of a post and the timer of the next poll. The real clock by default. */
	clock?: PromptClock;
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

/** A batch of one line that starts with `/` (and not `//`) is for the prompt, never the tower. */
const commandOf = (lines: string[]): string | undefined => {
	const [only] = lines;
	return lines.length === 1 && only !== undefined && only.startsWith("/") && !only.startsWith("//") ? only.trim() : undefined;
};

/** Runs the prompt until it ends; resolves the exit code. */
export async function runPrompt(o: PromptOptions): Promise<number> {
	const clock = o.clock ?? REAL_CLOCK, text = textsFor(o.locale), pollMs = o.pollMs ?? POLL_MS, wakingMs = Math.min(pollMs, o.wakingPollMs ?? WAKING_POLL_MS), source = o.source;
	const terminal = (o.output as Partial<NodeJS.WriteStream>).isTTY === true;
	let rl: Interface | undefined, closed = false, finished = false, posting = false, silent = false, shown: string | undefined, wokeAt: number | undefined;
	let timer: object | undefined, batch: string[] = [], batchTimer: ReturnType<typeof setTimeout> | undefined, pasteTimer: ReturnType<typeof setTimeout> | undefined, pasting = false;
	// Input chunks grouped, and the group the last line came in: a paste is one group however many reads carry it, typed keys are groups of their own (RV16-F003, RV17-F001, RV17-F002).
	let chunks = 0, lineChunk = 0, lastDataAt = -Infinity;
	const pasteCapMs = o.pasteCapMs ?? PASTE_CAP_MS;
	let finish!: (code: number) => void;
	const done = new Promise<number>((resolve) => (finish = resolve));

	/**
	 * A line of its own. On a terminal it replaces the line the cursor is on (the prompt and what the boss typed, which `again` draws back below it); a line that ends the prompt asks for no prompt again,
	 * and none is drawn on an interface that was closed (Ctrl+D closes it before this runs: a prompt on it throws ERR_USE_AFTER_CLOSE, which a pane showed and a test with no terminal did not).
	 */
	const say = (line: string, again = true) => {
		if (terminal) {
			cursorTo(o.output, 0);
			clearLine(o.output, 0);
		}
		o.output.write(`${line}\n`);
		if (again && terminal && rl && !closed && !finished) rl.prompt(true);
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
			await after();
		} catch {
			// The server may be gone: the prompt ends all the same.
		}
		finish(0);
	};
	const header = (a: PollAnswer) => text.header(clean(a.label), { state: clean(a.state) as PollAnswer["state"], queued: Number.isFinite(a.queued) ? a.queued : 0 });

	/** What one poll does to the screen; returns whether the prompt goes on. */
	const handle = async (polled: Awaited<ReturnType<PromptSource["poll"]>>): Promise<boolean> => {
		if (polled.kind === "gone") {
			say(text.noTower, false);
			await end(async () => {});
			return false;
		}
		if (polled.kind === "wait") {
			if (!silent) say(text.silent(clean(polled.why)));
			silent = true;
			return true;
		}
		if (silent) say(text.back);
		silent = false;
		if (polled.answer.leave) {
			// The boss's line is on its way (the post ends the prompt, or refuses and the prompt goes on).
			if (posting) return true;
			// A run is starting in this pane while the boss is typing: their words are for the tower, and the pane is a shell in a moment, where they must not land. What they entered (the paste window) and what is on the line go first.
			const entered = [...batch, rl?.line ?? ""];
			if (entered.at(-1) === "" && entered.length > 1) entered.pop();
			// The batch rule of `flush` holds here too: a lone `/` line (`/quit`, `/new`, `/reload` typed a moment before the order came) is a command or refused, never the boss's words (RV11-F002). The pane is leaving, so there is nothing to start over or quit.
			const words = commandOf(entered) !== undefined ? "" : entered.join("\n").trim();
			// The boss wrote a while ago and the prompt said so then: the line is only cleared.
			if (wokeAt === undefined) say(text.waking, false);
			else if (terminal) {
				cursorTo(o.output, 0);
				clearLine(o.output, 0);
			}
			await end(async () => {
				if (words) {
					try {
						await source.post(words);
					} catch (cause) {
						o.output.write(`${text.refused(clean((cause as Error).message, 400))}\n${words.split("\n").map((l) => clean(l, 2000)).join("\n")}\n`);
					}
				}
				await source.gone();
			});
			return false;
		}
		// The boss wrote and the run has not taken the pane: the order to leave comes with its start, so the prompt asks fast until then. A tower that stands by with nothing queued, a moment after the post, has no wake pending.
		// A held service starts no run, and a wake that is not seen to start within the cap is not asked for fast for ever.
		if (wokeAt !== undefined && ((polled.answer.state === "standing" && polled.answer.queued === 0 && clock.now() - wokeAt > WAKING_GRACE_MS) || polled.answer.state === "held" || clock.now() - wokeAt > WAKING_MAX_MS)) wokeAt = undefined;
		const line = header(polled.answer);
		if (line !== shown) {
			shown = line;
			say(line);
		}
		return true;
	};
	const poll = async () => {
		if (finished) return;
		const polled = await source.poll().catch((cause: Error) => ({ kind: "wait" as const, why: cause.message }));
		if (finished || !(await handle(polled))) return;
		timer = clock.after(() => void poll(), nextPoll());
	};
	/** Fast while a wake is pending: the run starts in about a second, and the prompt must be told to leave then, not seconds later. */
	const nextPoll = () => (wokeAt !== undefined ? wakingMs : pollMs);

	/** The boss wrote: what arrived together is one message; an empty one wakes the tower without words. */
	const flush = async () => {
		const lines = batch;
		batch = [];
		// A batch of one line that starts with `/` is for the prompt, never the tower (a `/reload` typed from habit is no message): `/new` alone starts a new boss session, `/quit` alone leaves the pane to the shell
		// as Ctrl+D does, and any other is refused with what the prompt takes. `//` at the start, or a space before the `/`, keeps the line a message (posted as typed; the space is trimmed with the rest of the message's
		// edges). A paste of several lines is one message whatever its first line is, and its `/` lines are never obeyed (a log that starts with a path, a file list with `/quit` in it).
		const word = commandOf(lines);
		if (word !== undefined) {
			if (word === "/new") return void (await startOver());
			if (word === "/quit") return leave();
			return void say(text.unknownCommand(clean(word.split(/\s+/)[0], 40)));
		}
		const message = lines.join("\n").trim() || NO_MESSAGE;
		posting = true;
		try {
			await source.post(message);
		} catch (cause) {
			posting = false;
			if (finished) return; // the boss left while the post was on its way
			say(text.refused(clean((cause as Error).message, 400)));
			if (!terminal) rl?.prompt(); // a terminal drew it already, with what the boss typed
			return;
		}
		// The prompt stays (see the top): the order to leave comes with the run's start, and what the boss types meanwhile is held in the line and posted then.
		posting = false;
		if (finished) return;
		wokeAt = clock.now();
		if (timer) clock.cancel(timer);
		timer = clock.after(() => void poll(), nextPoll());
		say(text.waking);
		if (!terminal) rl?.prompt();
	};

	const startOver = async () => {
		try {
			await source.fresh();
			say(text.fresh);
		} catch (cause) {
			say(text.refused(clean((cause as Error).message, 400)));
		}
	};

	o.signal?.addEventListener("abort", () => void end(() => source.gone()), { once: true });
	// The first look comes before the screen: a tower that is gone, or a run that is already starting, needs no prompt.
	const first = await source.poll().catch((cause: Error) => ({ kind: "wait" as const, why: cause.message }));
	if (!(await handle(first))) return done;
	for (const line of text.hint) o.output.write(`${line}\n`);
	// Counted before readline reads the chunk, so the lines it makes from it are in the chunk's count.
	// A chunk joins the group before it when a bracketed paste is open (up to its end marker, which is in the chunk that ends it), or when it follows the one before within the paste window and carries more than one
	// character: a typed key is one character in a read of its own, so a typed `/quit⏎` and a key typed after it, even a few ms later, are two groups (RV16-F003), and a paste split by the pty into reads is one.
	o.input.on("data", (data: string | Buffer) => {
		const at = clock.now();
		if (!(pasting || (at - lastDataAt < PASTE_MS && data.length > 1))) chunks++;
		lastDataAt = at;
		if (pasting) armPasteCap();
	});
	rl = createInterface({ input: o.input, output: o.output, prompt: PROMPT, terminal });
	/**
	 * The paste window closes: what was entered goes as one message. Two things keep it open (B6 VM round 3c, Windows PowerShell: a paste of three lines and the Enter sent a moment later were two messages): a bracketed
	 * paste that has not ended (the terminal says where it ends, however far apart its pieces arrive), and a line the boss is still writing after lines that arrived with it (a paste whose last line has no line end yet;
	 * the Enter that ends it comes later and joins the batch). The run's start does not wait for either: `handle` takes the batch and the line together.
	 * A line is held as part of a paste only when it came in the same group of input chunks as the line being written (a group: the reads of an open bracketed paste, and reads that follow within the paste window with
	 * more than one character each); a line typed on its own (`/quit⏎`) and a key typed after it are groups apart (RV16-F003, RV17-F001, RV17-F002). A paste that
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
	rl.on("line", (raw) => {
		if (finished || posting) return;
		batch.push(raw);
		lineChunk = chunks;
		armFlush();
	});
	// Only a terminal's readline reports keys; a piped input has no markers to honour.
	o.input.on("keypress", (_text: string | undefined, key?: { name?: string }) => {
		if (finished || posting) return;
		if (key?.name === PASTE_START) {
			pasting = true;
			clearTimeout(batchTimer);
			armPasteCap();
		} else if (key?.name === PASTE_END) endPaste();
	});
	// Ctrl+D (the end of the input) and Ctrl+C both leave the pane to the boss: a prompt that came back at once would be in the way of whatever they wanted a shell for.
	// It always ends the prompt as a park, whatever is held: a paste or a line the boss has not sent is dropped with the pane (Ctrl+C cancels it, nothing is posted later), and a close of the input is the same end, since a
	// prompt that went on with dead input would be killed by the next Ctrl+C without the server being told (RV16-F001).
	const leave = () => {
		if (finished) return;
		batch = [];
		say(text.leaving, false);
		void end(() => source.leave());
	};
	rl.on("close", () => void ((closed = true), leave()));
	rl.on("SIGINT", leave);
	rl.prompt();
	if (!finished) timer = clock.after(() => void poll(), pollMs);
	return done;
}
