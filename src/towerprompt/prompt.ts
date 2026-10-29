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
/** Lines that arrive this close together are one paste, one message. */
const PASTE_MS = 40;
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
}

/** Nothing the server sends reaches the terminal as a control sequence. */
const clean = (value: unknown, max = 200) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, max);

/** Runs the prompt until it ends; resolves the exit code. */
export async function runPrompt(o: PromptOptions): Promise<number> {
	const text = textsFor(o.locale), pollMs = o.pollMs ?? POLL_MS, wakingMs = Math.min(pollMs, o.wakingPollMs ?? WAKING_POLL_MS), source = o.source;
	const terminal = (o.output as Partial<NodeJS.WriteStream>).isTTY === true;
	let rl: Interface | undefined, closed = false, finished = false, posting = false, silent = false, shown: string | undefined, wokeAt: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined, batch: string[] = [], batchTimer: ReturnType<typeof setTimeout> | undefined;
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
		clearTimeout(timer);
		clearTimeout(batchTimer);
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
			const words = [...batch, rl?.line ?? ""].join("\n").trim();
			// The boss wrote a while ago and the prompt said so then: the line is only cleared.
			if (wokeAt === undefined) say(text.waking, false);
			else if (terminal) (cursorTo(o.output, 0), clearLine(o.output, 0));
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
		if (wokeAt !== undefined && polled.answer.state === "standing" && polled.answer.queued === 0 && Date.now() - wokeAt > WAKING_GRACE_MS) wokeAt = undefined;
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
		timer = setTimeout(() => void poll(), nextPoll());
	};
	/** Fast while a wake is pending: the run starts in about a second, and the prompt must be told to leave then, not seconds later. */
	const nextPoll = () => (wokeAt !== undefined ? wakingMs : pollMs);

	/** The boss wrote: what arrived together is one message; an empty one wakes the tower without words. */
	const flush = async () => {
		const message = batch.join("\n").trim() || NO_MESSAGE;
		batch = [];
		posting = true;
		try {
			await source.post(message);
		} catch (cause) {
			say(text.refused(clean((cause as Error).message, 400)));
			posting = false;
			if (!finished && !terminal) rl?.prompt(); // a terminal drew it already, with what the boss typed
			return;
		}
		// The prompt stays (see the top): the order to leave comes with the run's start, and what the boss types meanwhile is held in the line and posted then.
		posting = false;
		wokeAt = Date.now();
		clearTimeout(timer);
		timer = setTimeout(() => void poll(), nextPoll());
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
	rl = createInterface({ input: o.input, output: o.output, prompt: PROMPT, terminal });
	rl.on("line", (raw) => {
		if (finished || posting) return;
		// `/new` alone is the prompt's own command, not a message: the next boss conversation starts a new session.
		if (!batch.length && raw.trim() === "/new") return void startOver();
		batch.push(raw);
		clearTimeout(batchTimer);
		batchTimer = setTimeout(() => void flush(), PASTE_MS);
	});
	// Ctrl+D (the end of the input) and Ctrl+C both leave the pane to the boss: a prompt that came back at once would be in the way of whatever they wanted a shell for.
	const leave = () => {
		if (finished || posting || batch.length) return;
		say(text.leaving, false);
		void end(() => source.leave());
	};
	rl.on("close", () => void ((closed = true), leave()));
	rl.on("SIGINT", leave);
	rl.prompt();
	if (!finished) timer = setTimeout(() => void poll(), pollMs);
	return done;
}
