import type { ServiceState } from "../server/runs.ts";
import type { DigestRow } from "../server/waitlist.ts";
import type { Tower } from "../waitview.ts";

// What the tower prompt's screen asks of the server (docs/how-it-works.md, The standing pane). The screen (prompt.ts) knows only this seam, so the state it shows can grow (the net's rows, the board's `now`
// lines) without a change to how a line is read or how the prompt leaves; serversource.ts is the one that talks to the sb server over its control socket.

/** What a poll of the server says of the tower the pane stands in for. */
export interface PollAnswer {
	label: string;
	state: ServiceState;
	queued: number;
	/** A run is starting (or the server is ending the service): the prompt gives the pane up. */
	leave: boolean;
	/** The service is the head tower's: its title carries the crown and says `head tower`, not the label of a workspace. */
	head?: true;
	/** The open wait cards of this tower (waitlist.ts `DigestRow`, at most 12), and whether auto mode is on: what the block under the state line shows. A server that sends none is an older one. */
	waits?: DigestRow[];
	auto?: boolean;
	/** Events wait, and the server holds the tower's wake because this prompt's polls say the boss is answering cards (runs.ts `answering`). */
	holding?: true;
	/** The device is unattended (no boss at it): the cards are shown as a block, and the card view takes the keys only when `/wait` asks for it. */
	unattended?: true;
	/** Headless runs: the transcript lines since the last poll (the server's ring, prefixes its own), and the dialogs its runs wait on (entry.ts). */
	lines?: string[];
	dialogs?: { key: string; method: string; title: string; message?: string; options?: string[] }[];
	/** The head's viewer under headless runs: the open wait cards of the other towers (`<workspace>:<id>`), so its card view reads them again when one comes or goes; only the head's own block it. */
	elsewhere?: string[];
}
/** The answer of one poll: the state; the server stands in for no tower here any more (the prompt ends for good); or no usable answer yet (the server is down, restarting, or still loading). */
export type Polled = { kind: "state"; answer: PollAnswer } | { kind: "gone"; error?: string } | { kind: "wait"; why: string };

/** What the picker (pick.ts) presses with: the server's own reads and presses, asked with the state folder's secret and never with a run's token. Each rejects with the server's own words. */
export interface PickSource {
	/** `boss-waits`: every open card, this tower's first. */
	waits(): Promise<{ auto: boolean; towers: Tower[] }>;
	/** `tower-memory { op: "press" }` on a workspace (the head's is its constant key): the memory route's `status` and `body`. */
	press(workspace: string, json: Record<string, unknown>): Promise<{ status?: number; body?: Record<string, unknown> }>;
	/** The boss's words to a card's tower with `answers` (the GUI composer's route; the head's own for the head); which wait it marked answered. */
	reply(tower: { workspace: string; head?: true }, text: string, answers: string): Promise<{ answered?: string }>;
	/** Runs `fn` with this pane marked for this computer's keys only (heremark.ts); rejects, without running `fn`, when the pane cannot be marked. */
	here<T>(fn: () => Promise<T>): Promise<T>;
}

export interface PromptSource {
	/** The picker's source; a source with none cannot press cards. */
	pick?: PickSource;
	/** `answering`: the boss is at the card view's keys (cardview.ts); the server holds the tower's wake while the polls say so. `draft`: the boss has words on the line (or in a card's field, or the picker): the server keeps the pane open (towerstow.ts). */
	poll(answering?: boolean, draft?: boolean): Promise<Polled>;
	/** Posts the boss's words to the tower as a `boss` event; rejects with the server's own words when it does not take them. */
	post(text: string): Promise<void>;
	/** The boss typed `/new`: the next boss conversation is a new session (the server's `tower-new`, the function `/boss tower new` and the GUI's New reach); rejects with the server's own words. */
	fresh(): Promise<void>;
	/** The boss took the pane with Ctrl+D (or Ctrl+C): the server stops asking for the prompt for a while. Best effort. */
	leave(): Promise<void>;
	/** The prompt is ending on its own, because a run starts or the boss woke the tower: the server need not wait for it. Best effort. */
	gone(): Promise<void>;
	/** Headless runs (entry.ts): `/stop` aborts the live turn (false when none runs); `@<workspace>` posts the boss's words straight to that tower; a dialog's answer. Each rejects with the server's own words. */
	abort?(): Promise<boolean>;
	direct?(to: string, text: string): Promise<{ label: string }>;
	answer?(key: string, reply: { value?: string; confirmed?: boolean; cancelled?: true }): Promise<void>;
}
