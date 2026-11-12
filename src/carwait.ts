import { type CarView, livesOf, noticeStatus } from "./train/cars.ts";

// The integrator's wait for a `returned` notice (docs/specs/2026-11-07-train-workers.md §5.5; issue #13). A car the integrator returns at receipt has no train, so no todo of anyone waits for its notice: when the sb server stops before the notice is
// delivered (after a failed first send, or between setting the state and the first send), its book is gone, the journal on disk is not read back (CR-F003), and nobody would tell the coordinator. So the session that returned the car waits itself: it asks
// the server's book (`cars-read`) until the notice is told, and when the server no longer holds the car it calls the tower `blocked` with the notice text. The wait is this process's memory; nothing is read from disk. A session that ends while it
// still waits (the tower closes an idle integrator) hands what it waits for to the tower first, since nobody waits after it, and so does a wait the server left undelivered for a day; a process that is killed hands over nothing.

const KEEP_MS = 24 * 3600_000, CALL_RETRY_MS = 30_000, CALL_TRIES = 10;

/** One returned car whose notice this session waits for: the car, the session that set it, the moment the server set the state (`at`, which names that state among the car's lives), who is told, and the notice line. */
export interface ReturnWait { session: string; project: string; app: string; head: string; ticket: string; coordinator: string; at: string; line: string; since: number; calls?: number; called?: number }

/** Where the waits of this process are kept: on `globalThis`, so a `/reload` (a new module in the same process) goes on waiting; never in a file. */
const HELD = Symbol.for("pi-straw-boss.cars.returns");
const heldWaits = (): ReturnWait[] => ((globalThis as { [HELD]?: ReturnWait[] })[HELD] ??= []);

export interface ReturnWatchDeps {
	/** This session's id; a wait another session of this process made is left alone. */
	session(): string | undefined;
	/** The cars of a project as the server shows them to this session (`cars-read`); rejects when the server does not answer. */
	read(project: string): Promise<CarView[]>;
	/** One `blocked` call to the tower of this session's workspace, no reply expected; rejects when the tower did not take it. */
	callTower(text: string): Promise<unknown>;
	now(): number;
	/** Where the waits are kept (a test gives its own). */
	waits?: ReturnWait[];
	log?(text: string): void;
}

/** Why a notice is handed to the tower: the server lost it, the session that waited for it ends, or the server did not deliver it in a day. */
export const WHY = {
	lost: "the sb server restarted and holds neither the car nor its notice",
	ended: "its integrator's session ends while the notice is not delivered yet (the sb server may still deliver it, and nobody else waits for it)",
	stale: "the sb server has not delivered the notice in a day",
} as const;
/** What the tower is told of a returned car whose notice nobody can confirm. */
export const handedWord = (wait: Pick<ReturnWait, "ticket" | "project" | "app" | "coordinator" | "line">, why: string) =>
	`car ${wait.ticket} is returned (${wait.project}/${wait.app}) and sb cannot confirm that its coordinator ${wait.coordinator} was told: ${why}. Tell that coordinator the notice, by its session id, or find its owner. The notice: ${wait.line}`;

export function createReturnWatch(d: ReturnWatchDeps) {
	const waits = d.waits ?? heldWaits();
	let busy = false;
	const drop = (wait: ReturnWait) => { const i = waits.indexOf(wait); if (i >= 0) waits.splice(i, 1); };
	const mine = () => { const session = d.session(); return waits.filter((w) => w.session === session); };

	/** Hands a notice to the tower: taken, the wait is over; not taken, it is asked again 30 s later, ten times at most (as the server's sender asks). */
	async function hand(wait: ReturnWait, why: string, now: number): Promise<void> {
		if (wait.called !== undefined && now - wait.called < CALL_RETRY_MS) return;
		wait.called = now;
		wait.calls = (wait.calls ?? 0) + 1;
		try {
			await d.callTower(handedWord(wait, why));
			drop(wait);
		} catch (error) {
			d.log?.(`the tower did not take the call for car ${wait.ticket} (${(error as Error).message.slice(0, 160)})`);
			if (wait.calls >= CALL_TRIES) drop(wait);
		}
	}

	/** One look at every wait of this session: told or answered by a later state ends it, a car the server no longer holds is handed to the tower, and a server that does not answer is asked again at the next look. */
	async function tick(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			const now = d.now(), views = new Map<string, CarView[] | undefined>();
			for (const wait of mine()) {
				if (!views.has(wait.project)) views.set(wait.project, await d.read(wait.project).catch(() => undefined));
				const cars = views.get(wait.project);
				if (!cars) continue; // the server does not answer (it may be starting): the wait stays, however long
				const lives = livesOf(cars, wait.app, wait.head), life = lives.find((v) => v.file.states.some((s) => s.state === "returned" && s.at === wait.at));
				if (life) {
					// The server holds the state: told (delivered, or the tower was told by the server) ends the wait. While it still sends, the wait goes on, for a day: the server stops sending then, so the tower is handed what it left.
					if (noticeStatus(life.notice, "returned").kind !== "pending") drop(wait);
					else if (now - wait.since > KEEP_MS) await hand(wait, WHY.stale, now);
					continue;
				}
				// The car is in the book with another state: its coordinator sent the slip again after a restart, and that slip's state is the answer it gets.
				if (lives.length) { drop(wait); continue; }
				// The server holds nothing of the car: it started again and the notice went with its book.
				await hand(wait, WHY.lost, now);
			}
		} finally { busy = false; }
	}

	/** The session ends (not a reload): one last look, then every notice still awaited is handed to the tower, once, and the wait is over either way. */
	async function end(): Promise<void> {
		await tick();
		for (const wait of mine()) {
			drop(wait);
			try { await d.callTower(handedWord(wait, WHY.ended)); } catch (error) { d.log?.(`the tower did not take the call for car ${wait.ticket} (${(error as Error).message.slice(0, 160)})`); }
		}
	}

	return {
		end,
		/** A car this session just returned: its notice is waited for from now on. */
		add(wait: Omit<ReturnWait, "session" | "since" | "calls" | "called">): void { waits.push({ ...wait, session: d.session() ?? "", since: d.now() }); },
		tick,
		/** How many notices this session still waits for. */
		size: () => mine().length,
	};
}
export type ReturnWatch = ReturnType<typeof createReturnWatch>;
