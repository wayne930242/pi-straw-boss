import type { ServiceState } from "../server/runs.ts";

// What the tower prompt's screen asks of the server (docs/how-it-works.md, The standing pane). The screen (prompt.ts) knows only this seam, so the state it shows can grow (the net's rows, the board's `now`
// lines) without a change to how a line is read or how the prompt leaves; serversource.ts is the one that talks to the sb server over its control socket.

/** What a poll of the server says of the tower the pane stands in for. */
export interface PollAnswer {
	label: string;
	state: ServiceState;
	queued: number;
	/** A run is starting (or the server is ending the service): the prompt gives the pane up. */
	leave: boolean;
}
/** The answer of one poll: the state; the server stands in for no tower here any more (the prompt ends for good); or no usable answer yet (the server is down, restarting, or still loading). */
export type Polled = { kind: "state"; answer: PollAnswer } | { kind: "gone"; error?: string } | { kind: "wait"; why: string };

export interface PromptSource {
	poll(): Promise<Polled>;
	/** Posts the boss's words to the tower as a `boss` event; rejects with the server's own words when it does not take them. */
	post(text: string): Promise<void>;
	/** The boss typed `/new`: the next boss conversation is a new session (the server's `tower-new`, the function `/boss tower new` and the GUI's New reach); rejects with the server's own words. */
	fresh(): Promise<void>;
	/** The boss took the pane with Ctrl+D (or Ctrl+C): the server stops asking for the prompt for a while. Best effort. */
	leave(): Promise<void>;
	/** The prompt is ending on its own, because a run starts or the boss woke the tower: the server need not wait for it. Best effort. */
	gone(): Promise<void>;
}
