import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import type { startDashboard } from "./dashboard.ts";
import type { CoordinatorDuty } from "./duty.ts";
import type { StartRead } from "./handover.ts";
import type { Ask } from "./host.ts";
import type { HerdrApi, HerdrCall, HerdrRun, HerdrWorld, Place, Session, Sleep } from "./herdr.ts";
import type { LinkDeps } from "./link/runtime.ts";
import type { FaceSeams } from "./lanface.ts";
import type { RunSideDeps } from "./runmode.ts";
import type { TrainId } from "./trainrole.ts";
import type { ServerLookDeps } from "./server-look.ts";
import type { HerdrEvents, HerdrWatch } from "./server-watch.ts";

// What the modules of one session share: its configuration (`Config`, fixed at start) and the one mutable `State` they read and write. Each
// module keeps its own timers and in-flight work to itself; a field lives here only when two modules look at it.

/** The session entry the extension writes to the pi session (a tower's mark, an orphan nudge) and the key of its system prompt section. */
export const ENTRY = "straw-boss";
/** The entry an ally run writes into its own session: a mark that outlives the server's run records, so a pi that later resumes the session is told to quit (the server grants nothing else on its word). */
export const ALLY_ENTRY = "straw-boss-ally";
// pi-intercom's extension API as constants and minimal types: intercom is a runtime requirement, not an import.
export const REGISTER = "intercom:extension-register";

export interface Channel {
	snapshot(): { connected: boolean; supported: boolean; owner?: { sessionId: string }; state?: { payload: unknown } };
	publish(payload: unknown, options?: { audience?: "owner" | "capable" }): void;
	commitState(payload: unknown, expectedRevision?: number): void;
	listSessions(): Promise<Session[]>;
}
export interface SendResult { requestId?: string; status: string; code?: string; detail?: string }
/** `duty*`: the main's kind and why it has it, written whole at each switch (docs/specs/2026-11-09-agent-kinds.md §2: entries merge field by field, so every entry carries all four). */
export interface Saved { tower?: boolean; openedBy?: string | null; openedPane?: string; train?: TrainId; duty?: CoordinatorDuty; dutyFrom?: CoordinatorDuty | null; dutyWhy?: string; dutyAt?: number; /** When a tower revived this session (docs/specs/2026-11-23-tower-revive.md §6): its inherited subagents are looked at from every start after. */ revived?: number; /** The successor this main opened with boss_handover (handover.ts): its pane, while it lives, refuses a second one. */ successor?: { pane: string; tab: string; at: number; /** Its session id: the role record's `handedOver` mark (roles.ts). */ main?: string } }
export type Role = "tower" | "main" | "member" | "train";
export type Scope = "tab" | "workspace" | "towers" | "all";
/**
 * `run` is the CLI for every command; left out, Herdr's listings, `pane current`, and `report-metadata` go over the socket instead (`socketRun`) and `world` is one `session.snapshot`. `world` is the dashboard's and the GUI's reading of panes and workspaces.
 * `integrationMs` is how long after its start a session checks that Herdr's pi integration is in place (integration.ts); `joinRetryMs` is the waits between a session's asks when its start could not place it or join the net (the last one repeats; session.ts); `adoptMs` is how often a session looks after the sb server; `ask` is how it reaches the server's GUI (host.ts; the control socket by default, through the look); `startRead` is where the recorded server's start time is read from (handover.ts; the process's own cache by default).
 */
export interface Deps { run?: HerdrRun; world?: HerdrWorld; api?: HerdrApi; call?: HerdrCall; copy?: (text: string) => Promise<void>; env?: NodeJS.ProcessEnv; sleep?: Sleep; promptDir?: string; openUrl?: (url: string) => Promise<void>; watch?: HerdrWatch; stateDir?: string; autoTower?: boolean; nudgeMs?: number; version?: string; guardMs?: number; couple?: boolean; events?: HerdrEvents; detectMs?: number; now?: () => number; later?: (pid: number, args: string[]) => void; adoptMs?: number; restoreMs?: number; integrationMs?: number; joinRetryMs?: number[]; link?: LinkDeps; server?: ServerLookDeps | null; ask?: Ask; startRead?: StartRead; runSide?: RunSideDeps; face?: FaceSeams; /** The session's working folder, where its project's apps.json is read (`process.cwd()`). */ cwd?: () => string }
/** The dependencies with their defaults filled in; `server` (how a session looks after the sb server, server-look.ts) is null in a session that does not: a test world. */
export type Config = Required<Omit<Deps, "stateDir" | "link" | "server" | "ask" | "startRead" | "runSide" | "face">> & Pick<Deps, "stateDir" | "link" | "server" | "ask" | "startRead" | "runSide" | "face">;

export interface State {
	// What this session is.
	isTower: boolean;
	joined: boolean;
	isMain: boolean;
	/** This session is the train the tower opened in its tab (docs/specs/2026-11-07-train-workers.md §3.3): a role of its own, never the tab's main. `train` names its project and code. */
	isTrain: boolean; train: TrainId | undefined;
	/** Whether this start has decided if it is a train (session.ts): a train's guard stays closed until it has, when a local sign (trainguard.ts `pending`) says it may be one. */
	trainSettled: boolean;
	/** The local signs of a train (trainguard.ts `signsOfTrain`) taken once at the start and held here: the guard reads this copy, so a record moved away mid-window changes nothing. */
	trainSign: boolean;
	/** The conditional tools, decided at each session start and nowhere else (docs/specs/2026-11-23-lite-main.md §4): a tool list that changes mid-session rewrites the cached prompt. */
	toolSet: { link: boolean; cars: boolean; carApp: boolean } | undefined;
	holdsTower: boolean;
	/** Why this session cannot join: it sits in a sub workspace, or Herdr could not say whether it does. */
	barred: string | undefined;
	/** While the sub workspace check has no definitive answer: asks Herdr again (or joins the one in flight) and settles `barred`. A caller that needs the net waits for it first (membership.ts). */
	recheck: (() => Promise<void>) | undefined;
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
	/** The kind this main declared or was migrated to (mainduty.ts); `dutyNow()` is what it runs as. Set from the session's entries at each start. */
	duty: CoordinatorDuty | undefined;
	/** The session's branch of entries now (set at each start), for the todo list a plan and a train sign are read from. */
	branch: () => readonly unknown[];
	/** The pi session file, the key of this session's role record (roles.ts), and whether the role being taken is one a Herdr restore gave back. */
	file: string | undefined;
	restored: boolean;
	/** Claims, refreshes, and guard checks run one at a time through this chain. */
	queue: Promise<void>;
	/** Set while this session holds the tower role. */
	dashboard: ReturnType<typeof startDashboard> | undefined;
	// The GUI runs in the sb server; `viewer` is the channel of a session outside the net that only reads the sessions (host.ts).
	viewer: Channel | undefined;
	/** `remote:<sender device id>` while the run is a Straw Link remote turn: what a message to a local session carries in its header as `origin=`. */
	remoteOrigin: string | undefined;
	/** The session id this session wrote its board entry under (board_set): pi-intercom clears the id from the environment before the shutdown hook runs, so it is remembered when written. */
	boardId: string | undefined;
	// Closing: `quit` is pi's shutdown for this session, `closing` says it was asked for (and whether the pane stays).
	quit: (() => void) | undefined;
	closing: { keepPane: boolean } | undefined;
	/** Whether auto mode is on as this session last read it (auto.ts); the Straw Link gate asks it. */
	autoOn: () => boolean;
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
		isTower: env.STRAW_BOSS_ROLE === "tower", joined: false, isMain: false, isTrain: false, train: undefined, trainSettled: false, trainSign: false, holdsTower: false, barred: undefined, recheck: undefined, stopped: false,
		// SAFETY: `c` and `at` are set by the join (or the tower's start) before any module reads them; the GUI's `sessions()` tests `c` for undefined.
		c: undefined as unknown as Channel,
		// SAFETY: as `c` above.
		at: undefined as unknown as Place,
		mainId: undefined, pinned: undefined, toolSet: undefined, info: {}, ownName: "", openedBy: undefined, restoredOpener: undefined, kids: new Set(),
		ui: undefined, hasUI: false, saved: {}, duty: undefined, branch: () => [], file: undefined, restored: false, queue: Promise.resolve(), dashboard: undefined, viewer: undefined, quit: undefined, closing: undefined, remoteOrigin: undefined, boardId: undefined, autoOn: () => false,
	};
	const me = () => env.PI_INTERCOM_SESSION_ID ?? "";
	const role = (): Role | undefined => {
		if (s.isTower) return "tower";
		if (!s.joined) return undefined;
		if (s.isTrain) return "train";
		return s.isMain ? "main" : "member";
	};
	return {
		pi, cfg, s, me, role,
		guiDir: cfg.stateDir ?? join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "straw-boss"),
		tell: (text, level = "info") => s.ui?.notify(text, level),
	};
}
