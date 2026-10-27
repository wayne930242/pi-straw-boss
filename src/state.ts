import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import type { startDashboard } from "./dashboard.ts";
import type { Hub } from "./dialogs.ts";
import type { Gui } from "./gui.ts";
import type { GuiRecord } from "./handover.ts";
import type { HerdrApi, HerdrCall, HerdrRun, HerdrWorld, Place, Session, Sleep } from "./herdr.ts";
import type { LinkDeps } from "./link/runtime.ts";
import type { ServerLookDeps } from "./server-look.ts";
import type { Run } from "./remote.ts";
import type { HerdrEvents, HerdrWatch } from "./server-watch.ts";

// What the modules of one session share: its configuration (`Config`, fixed at start) and the one mutable `State` they read and write. Each
// module keeps its own timers and in-flight work to itself; a field lives here only when two modules look at it.

/** The session entry the extension writes to the pi session (a tower's mark, an orphan nudge) and the key of its system prompt section. */
export const ENTRY = "straw-boss";
// pi-intercom's extension API as constants and minimal types: intercom is a runtime requirement, not an import.
export const REGISTER = "intercom:extension-register";

export interface Channel {
	snapshot(): { connected: boolean; supported: boolean; owner?: { sessionId: string }; state?: { payload: unknown } };
	publish(payload: unknown, options?: { audience?: "owner" | "capable" }): void;
	commitState(payload: unknown, expectedRevision?: number): void;
	listSessions(): Promise<Session[]>;
}
export interface SendResult { requestId?: string; status: string; code?: string; detail?: string }
export interface Saved { tower?: boolean; openedBy?: string | null; openedPane?: string }
export type Role = "tower" | "main" | "member";
export type Scope = "tab" | "workspace" | "towers" | "all";
/**
 * `run` is the CLI for every command; left out, Herdr's listings, `pane current`, and `report-metadata` go over the socket instead (`socketRun`) and `world` is one `session.snapshot`. `world` is the dashboard's and the GUI's reading of panes and workspaces.
 * `gone` says whether the process that recorded a GUI server has ended for good (handover.ts `ownerGone`), which a survivor needs before it takes the server over; `adoptMs` is how often a session looks.
 */
export interface Deps { run?: HerdrRun; world?: HerdrWorld; api?: HerdrApi; call?: HerdrCall; tailscale?: Run; copy?: (text: string) => Promise<void>; env?: NodeJS.ProcessEnv; sleep?: Sleep; promptDir?: string; bundle?: string; openUrl?: (url: string) => Promise<void>; watch?: HerdrWatch; stateDir?: string; autoTower?: boolean; nudgeMs?: number; version?: string; guardMs?: number; couple?: boolean; events?: HerdrEvents; detectMs?: number; now?: () => number; later?: (pid: number, args: string[]) => void; gone?: (record: GuiRecord, wrote: number) => boolean; adoptMs?: number; restoreMs?: number; link?: LinkDeps; server?: ServerLookDeps | null }
/** The dependencies with their defaults filled in; `server` (how a session looks after the sb server, server-look.ts) is null in a session that does not: a test world, a net sidecar. */
export type Config = Required<Omit<Deps, "bundle" | "stateDir" | "link" | "server">> & Pick<Deps, "bundle" | "stateDir" | "link" | "server">;

export interface State {
	// What this session is.
	isTower: boolean;
	joined: boolean;
	isMain: boolean;
	holdsTower: boolean;
	/** Why this session cannot join: it sits in a sub workspace, or Herdr could not say whether it does. */
	barred: string | undefined;
	/** Set at shutdown: a refresh still in flight must not write tokens after they are cleared. */
	stopped: boolean;
	// Where it is and what the tab's net says. `c` and `at` are set by the join (or the tower's start) before anything reads them.
	c: Channel;
	at: Place;
	/** The tab's live main agent as of the last refresh, and the main this session pinned as owner before the broker echoes it back. */
	mainId: string | undefined;
	pinned: string | undefined;
	/** The words the role prompts fill in (tab, workspace, main, tower). */
	info: Record<string, string>;
	/** This session's intercom name, which the subagents it launched show as their launcher, and the subagent panes it has marked. */
	ownName: string;
	openedBy: string | undefined; restoredOpener: string | undefined; // the latter: what a restored main had (roles.ts), held until the promotion or the owner's late confirmation consumes it
	kids: Set<string>;
	// The pi session.
	ui: ExtensionContext["ui"] | undefined;
	hasUI: boolean;
	saved: Saved;
	/** The pi session file, the key of this session's role record (roles.ts), and whether the role being taken is one a Herdr restore gave back. */
	file: string | undefined;
	restored: boolean;
	/** Claims, refreshes, and guard checks run one at a time through this chain. */
	queue: Promise<void>;
	/** Set while this session holds the tower role. */
	dashboard: ReturnType<typeof startDashboard> | undefined;
	/** A tower's watch on the head workspace (headwatch.ts); stops with the session. */
	headWatch: (() => void) | undefined;
	// The GUI: the hub and server run in the session that shares it; `viewer` is the channel of a session outside the net that only reads.
	hub: Hub | undefined;
	gui: Gui | undefined;
	viewer: Channel | undefined;
	/** `remote:<sender device id>` while the run is a Straw Link remote turn: what a message to a local session carries in its header as `origin=`. */
	remoteOrigin: string | undefined;
	/** The session id this session wrote its board entry under (board_set): pi-intercom clears the id from the environment before the shutdown hook runs, so it is remembered when written. */
	boardId: string | undefined;
	// Closing: `quit` is pi's shutdown for this session, `closing` says it was asked for (and whether the pane stays).
	quit: (() => void) | undefined;
	closing: { keepPane: boolean } | undefined;
}

/** What every module is built from: the pi API, the configuration, the state, and the three things all of them ask. */
export interface Kit {
	pi: ExtensionAPI;
	cfg: Config;
	s: State;
	guiDir: string;
	me(): string;
	role(): Role | undefined;
	tell(text: string, level?: "info" | "warning" | "error"): void;
}

export function createKit(pi: ExtensionAPI, cfg: Config): Kit {
	const { env } = cfg;
	const s: State = {
		isTower: env.STRAW_BOSS_ROLE === "tower", joined: false, isMain: false, holdsTower: false, barred: undefined, stopped: false,
		// SAFETY: `c` and `at` are set by the join (or the tower's start) before any module reads them; the GUI's `sessions()` tests `c` for undefined.
		c: undefined as unknown as Channel,
		// SAFETY: as `c` above.
		at: undefined as unknown as Place,
		mainId: undefined, pinned: undefined, info: {}, ownName: "", openedBy: undefined, restoredOpener: undefined, kids: new Set(),
		ui: undefined, hasUI: false, saved: {}, file: undefined, restored: false, queue: Promise.resolve(), dashboard: undefined, headWatch: undefined, hub: undefined, gui: undefined, viewer: undefined, quit: undefined, closing: undefined, remoteOrigin: undefined, boardId: undefined,
	};
	const me = () => env.PI_INTERCOM_SESSION_ID ?? "";
	const role = (): Role | undefined => {
		if (s.isTower) return "tower";
		if (!s.joined) return undefined;
		return s.isMain ? "main" : "member";
	};
	return {
		pi, cfg, s, me, role,
		guiDir: cfg.stateDir ?? join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "straw-boss"),
		tell: (text, level = "info") => s.ui?.notify(text, level),
	};
}
