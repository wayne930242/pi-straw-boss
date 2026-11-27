import type { CarFact } from "./carfacts.ts";
import type { CarState } from "./cars.ts";
import type { Kind } from "./spec.ts";
import type { StepStatus, Wait } from "./waits.ts";

// The yards as the net snapshot carries them (docs/specs/2026-11-07-train-workers.md §11.1): types only, so the page can import them without the server's modules. Every string in a view has passed the server's reader as plain text
// (controls, escapes and bidi marks gone, a length cap), every number is a whole number or a plain finite one, and a unit `key` is the one the net itself holds, never a value a file chose.

/** The server's 1-minute load average and the core count (`Net.load`); absent where the platform has no load average (Windows). */
export interface NetLoad { now: number; cores: number }

/**
 * What kind of failure a reader's reason says: the file is over its size cap (`toobig`), the reading's byte budget is spent (`budget`), it is not a regular file (`notfile`), is not JSON (`notjson`), could not be read or listed (`io`), belongs to
 * another code, project or file name (`misplaced`), threw while it was shown (`failed`), or its shape fails the reader's checks (`shape`). The page says each in its own language; the reader's English `reason` goes beside it and stays text.
 */
export type ReasonKind = "toobig" | "budget" | "notfile" | "notjson" | "io" | "misplaced" | "shape" | "failed";

/** One acceptance the car's evidence shows (`kind`: `e2e`, `uat`, or the evidence's own label) and, when the train kept a copy of the evidence file, the words the approver gave. */
export interface YardAccepted { kind: string; nod?: string }
/** Whether sb has told the car's coordinator of the car's newest `state` (§5.5): `delivered` or `escalated` at `at`, or still `pending` after `attempts`, the last answer in `last`; or `unreadable`. */
export type YardNotice = { state: CarState; status: "delivered" | "pending" | "escalated"; attempts: number; at?: string; last?: string; /** Read from the journal on disk because the server's own record did not have the car (after a restart): the page says so (TB-F005). */ journal?: true }
	/** The car file or its notice record failed to read (a file out of shape, too big, a link, another project's); `reason` says why and nothing of what was told is guessed. */
	| { status: "unreadable"; reason: string; kind?: ReasonKind };
export interface YardCar { tickets: string[]; branch: string; head: string; departs: string; arrived?: string; accepted: YardAccepted[]; /** The code could not check the car's evidence, so the page says its acceptance is unknown (TB-F003). */ unverified?: true; notice?: YardNotice }

export interface YardStep {
	id: number; kind: Kind; name: string; status: StepStatus; round: number; outcome?: "passed" | "failed" | "void"; why?: "superseded" | "skipped";
	/** The CPU the step needs: its load limit (`max`, or `perCore` of the cores) and the cores it expects to use. */
	load?: { max?: number; perCore?: number; weight?: number };
	holds?: { lane?: string; target?: string };
	/** What an in-progress step waits for now (§7.3): load and lanes and targets from the server's own reading of the boards, locks as the train recorded them. */
	waits: Wait[];
	/** The gate wrapper's last word for an in-progress step, from its gate file. */
	gate?: { state: string; since: string; updated: string };
}

export interface YardTrainRow {
	code: string;
	app?: string;
	/** `unreadable`: the board failed to read; `reason` says why and nothing else of the train is shown. */
	state: "live" | "stale" | "ended" | "unreadable";
	reason?: string;
	reasonKind?: ReasonKind;
	/** The unit of the net whose pane's token names this train: the page opens its comms with it. */
	key?: string;
	/** Whether the process that wrote the board still runs. */
	writerLive?: boolean;
	round?: number;
	updated?: string;
	/** The cars the current round's assemble step left out, with why (a train's second round and after): plain text. */
	removed?: { ticket: string; why: string; notice?: YardNotice }[];
	cars: YardCar[];
	steps: YardStep[];
	/** How many older steps were left out (a train shows its newest 64). */
	stepsCut?: number;
	holds?: { lanes: string[]; targets: string[] };
}

export interface YardFormingRow { code: string; app: string; status: "forming" | "departing" | "refused"; cars: YardCar[]; departs?: { maxCars: number; maxWaitMin: number; oldest: string } }

export interface ProjectYard {
	project: string;
	/** The writer of the project's `yard.json`: `key` is its unit when the net has that session as a main; `live` whether its process runs. */
	integrator?: { key?: string; live: boolean; /** The writer is a live main of another kind now. */ switched?: true };
	/** Why `yard.json` could not be read (a file that is not there is no problem). */
	problem?: string;
	problemKind?: ReasonKind;
	forming: YardFormingRow[];
	trains: YardTrainRow[];
	/** The codes of the trains with a step that waits for a lane or target another train holds (「互相等待」). */
	waiting: string[];
	/** Where each car of the project is (docs/specs/2026-11-28-car-rows.md): a main's unit card shows those it coordinates; `cars-rows` answers a session with its own. */
	cars?: CarFact[];
}

/** `yards` of the snapshot: this computer's only (the `board` message, a remote turn and the operate slice never carry it). `truncated`: more trains or projects than the 64 read. `problems`: folders that could not be listed. */
export interface Yards { projects: ProjectYard[]; truncated?: true; problems?: string[] }

/** What the reader needs of the net to name units: the live unit of each train (its pane's `sb_train` token) and the keys of the mains. */
export interface YardJoin { trains: { key: string; project: string; code: string }[]; mains: ReadonlySet<string>; /** The mains that are integrators: those whose `sb_duty` says so, and those that publish none (a session still on an older sb during the upgrade window). */ integrators: ReadonlySet<string> }
