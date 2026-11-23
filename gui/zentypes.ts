import type { Item } from "../src/items.ts";
import type { Alert } from "./alerts.ts";
import type { Chat, Data, HistoryEvent, Who } from "./chat.ts";
import type { mountAsk } from "./ask.ts";
import type { Conn, Post as KeysPost, TermState } from "./mirrorconn.ts";
import type { mountComposer, Post } from "./composer.ts";
import type { Route } from "./router.ts";
import type { TrustPost, trustPanel } from "./trust.ts";
import type { FsEnv } from "./zenfs.ts";
import type { RippleEnv } from "./zenripple.ts";
import type { Candidate } from "./zenunits.ts";
import type { MenuDeps } from "./zenmenu.ts";
import type { MusicDeps } from "./zenmusicbar.ts";
import type { Sound, With } from "./zenmodel.ts";

// What the Zen layer (zen.ts) is given: the page's hooks and the panels it mounts.
/** Where leaving Zen goes (the page shows Standard first): an item's dialog opens over it (`item`), a session's comms open (`route`), or nothing more. */
export interface Exit { item?: Alert; route?: Route }
/** A terminal Zen shows in its own layer (zenterm.ts): a session's by its key, a pane an answer opened by `grant:<id>`. `armed`: the unit waits on this terminal now, so its next work ends the step. */
export interface Term { key: string; armed?: boolean }
/** The page's terminals behind the overlay chunk (mirror.ts, layer.ts): the full terminal embedded in a host, a terminal's connection without a screen (the card's), and what a write to its keys needs. */
export interface TermKit {
	embed(key: string, name: string, host: HTMLElement, o: { keys: boolean; end?: () => void; taken?: () => void }): () => void;
	watch(key: string, name: string, w: { rows(rows: string[]): void; state(s: TermState, c: Conn): void; end(): void; taken(): void }): { conn: Conn; stop(): void; retry(): void };
	post(key: string): KeysPost;
	stream(): string;
}
export interface ZenDeps {
	debug?(line: string): void; // a line for the page's console (default `console.debug`): why a question from a box waits off the screen
	data(key: string): Data;
	recent(key: string): Promise<Item[]>;
	/** The demo fixture's stand-in for the server's session endpoints; unset: the server's. */
	post?(key: string): Post | undefined;
	trust?: TrustPost;
	label(ws: string): string;
	online(): boolean;
	/** The system notification for the item that took the screen while the page is hidden or unfocused. */
	remind(a: Alert): void;
	/** Z5 fills this with the effects; Zen makes no sound of its own here. */
	sound(s: Sound): void;
	leave(to: Exit): void;
	/** The page's terminals (the overlay chunk's, fetched on the first call): the Zen terminal layer's card and full terminal. */
	terminals(): Promise<TermKit>;
	/** The session whose log the stream should send (the companion), or none. */
	watch(key: string | null): void;
	/** A paired device (`mountAsk`'s `remote`); unset: by the host name. */
	remote?: boolean;
	/** The companion a visit starts with; the page names none, so every visit starts at the breathing circle (Z-D16). */
	start?(): With | undefined;
	/** The corner menu's rows (language, view, sound); a row without its dep is left out. */
	menu?: MenuDeps;
	/** The core's candidates for the companion (`[` and `]`), and its counts of working and idle units for the strip (zenunits.ts); unset: no stepping, no strip. */
	companions?(): Candidate[];
	activity?(): { working: number; idle: number };
	/** The live trains and how many of them wait (trains.ts `zenTrains`): the strip says these two numbers and nothing more of the trains (docs/specs/2026-11-07-train-workers.md D9). */
	trains?(): { count: number; waiting: number };
	/** The page's settings route (the palette's Settings); unset: no such entry. */
	settings?(): void;
	/** The music controls (zenmusicbar.ts): the server's tracks, the player, the stored switch. Unset: no music control. */
	music?: MusicDeps;
	/** The full-screen control's page facts (a test gives its own). */
	fs?: FsEnv;
	/** The ripples' page facts (a test gives its own). */
	ripple?: RippleEnv;
	/** Whether the page holds still (reduced motion, calm): the idle line then stays as it is. */
	still?(): boolean;
	random?: () => number;
	now?: () => number;
	/** The page's timer (a test moves its own): runs `fn` after `ms` and returns what cancels it. */
	later?(fn: () => void, ms: number): () => void;
}
export type Mounts = { ask: typeof mountAsk; trust: typeof trustPanel; composer: typeof mountComposer; chat(): Promise<(root: HTMLElement, data: Data, deps: { who(): Who; link(): undefined; away(): boolean; live?: "quiet" }) => Chat> };
