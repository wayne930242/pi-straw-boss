import { join } from "node:path";
import { capDir, capOfTodos, capTasksOf, type MainCap, openOf, PAUSE_EVENT, type Pause, pauseOf, readCaps, removeCap, snoozeSaid, writeCap } from "./capacity.ts";
import type { Ask } from "./host.ts";
import { type Snooze, snoozeOf, withSnooze } from "./snooze.ts";
import type { Kit } from "./state.ts";
import { snapshotScan } from "./todo.ts";
import { ownsBoard } from "./trainrole.ts";
import { NOT_MAIN } from "./boardset.ts";

// A main's capacity facts (docs/specs/2026-11-24-capacity.md): its own session writes `<state dir>/capacity/<session>.json` from its todo list (read as the board's auto-fill reads it) and from the pause seam, whenever
// either changes. The seam is `straw-boss:pause` on pi's in-process event bus, which pi-agent-basic's quota resume emits in the session that stopped; nothing of basic is imported. A pause clears on `resumed` or when
// the session starts a new turn. The sb server joins the files with what runs (server/capwatch.ts).
// The stale reminder's snoozes (docs/specs/2026-11-28-stale-snooze.md) live here too, set by `board_set { snooze }`: kept across a /reload as the pause is, a todo's gone with the todo, a passed one at the next turn.

export interface CapFill {
	refresh(): void;
	/** `board_set`'s snooze, checked against the open todos and, for a watch, this session's own watches (the sb server's `watch-list`), kept, and written; throws with what to fix. */
	snooze(input: { watch?: string }, ask: Ask | undefined): Promise<{ text: string; details: { snooze: Snooze } }>;
}

export function createCapFill({ pi, cfg, guiDir, me, role }: Kit): CapFill {
	const dir = capDir(join(guiDir, "board")), snapshotOf = snapshotScan();
	let ctx: { sessionManager?: { getBranch(): readonly unknown[] } } | undefined, pause: Pause | undefined, snoozes: Snooze[] = [], last: string | undefined, wrote: string | undefined, restored = false;
	const branch = (): readonly unknown[] => { try { return ctx?.sessionManager?.getBranch() ?? []; } catch { return []; } }; // a replaced session's context throws
	// The whole ledger is projected again only when its snapshot changed (snapshotScan hands back the same one until a todo write): a refresh runs at every tool call (Performance in the stale-snooze spec).
	let seen: { snapshot: unknown; list: ReturnType<typeof capTasksOf>; keep?: string; key?: string; facts?: Omit<MainCap, "v" | "session" | "updated" | "pause" | "snoozes"> } | undefined;
	const listed = () => ((snapshot) => (seen?.snapshot === snapshot && seen ? seen : (seen = { snapshot, list: capTasksOf(snapshot) })))(snapshotOf(branch()));
	const restore = (id: string) => {
		// A /reload keeps the pause and the snoozes its file holds (the model is still stopped); read once, when the session's id is known (pi-intercom may set it after the start).
		if (restored) return;
		restored = true;
		const mine = readCaps(dir).find((x) => x.session === id);
		pause ??= mine?.pause;
		if (!snoozes.length) snoozes = mine?.snoozes ?? [];
	};
	/** Writes the file when its facts changed; a failed write is tried again at the next change, unless `strict` (board_set's snooze, review F004), which throws it. */
	const refresh = (strict = false) => {
		const id = me();
		if (!id || !ownsBoard(role())) return;
		try {
			restore(id);
			const at = listed(), { snapshot, list } = at, held = snoozes.flatMap((s) => (s.todo !== undefined ? [s.todo] : [])), keep = JSON.stringify(held);
			if (at.facts === undefined || at.keep !== keep) {
				const open = new Set(list.filter((t) => t.status !== "completed").map((t) => t.id));
				if (held.some((id) => !open.has(id))) snoozes = snoozes.filter((s) => s.todo === undefined || open.has(s.todo));
				[at.keep, at.facts] = [JSON.stringify(snoozes.flatMap((s) => (s.todo !== undefined ? [s.todo] : []))), { ...capOfTodos(list, snapshot), ...openOf(list, snapshot, new Set(snoozes.flatMap((s) => (s.todo !== undefined ? [s.todo] : [])))) }];
				at.key = JSON.stringify(at.facts);
			}
			const facts = at.facts, key = `${at.key}${JSON.stringify([pause ?? null, snoozes])}`;
			if (key === last && wrote === id) return;
			const cap: MainCap = { v: 1, session: id, updated: cfg.now(), ...facts, ...(pause ? { pause } : {}), ...(snoozes.length ? { snoozes } : {}) };
			writeCap(dir, cap);
			[last, wrote] = [key, id];
		} catch (error) {
			if (strict) throw new Error(`Nothing was snoozed: the capacity file could not be written (${(error as Error).message.slice(0, 200)})`, { cause: error });
			/* the board folder cannot be written: the next change tries again */
		}
	};
	const again = (c: unknown) => ((ctx = (c as typeof ctx) ?? ctx), refresh());
	pi.events?.on(PAUSE_EVENT, (data) => {
		const said = pauseOf(data, cfg.now());
		if (!said) return;
		pause = said.state === "paused" ? said.pause : undefined;
		refresh();
	});
	pi.on("session_start", (_e, c) => ((last = undefined), (restored = false), (pause = undefined), (snoozes = []), again(c)));
	pi.on("turn_start", (_e, c) => ((pause = undefined), (snoozes = snoozes.filter((s) => s.until > cfg.now())), again(c)));
	pi.on("turn_end", (_e, c) => again(c));
	pi.on("tool_execution_end", (_e, c) => again(c)); // the todo tool ends here
	pi.on("session_tree", (_e, c) => again(c));
	pi.on("session_compact", (_e, c) => again(c));
	pi.on("session_shutdown", (event) => {
		if ((event as { reason?: string }).reason !== "reload" && wrote) removeCap(dir, wrote);
	});
	return {
		refresh,
		async snooze(input, ask) {
			const id = me();
			if (!id || !ownsBoard(role())) throw new Error(NOT_MAIN);
			// The server reads the snoozes, so it is asked first: one of an older build drops them and would remind on regardless (review F003).
			const watched = await ask?.({ cmd: "watch-list", session: id }, { start: "never" }).catch(() => undefined);
			// The ask waited on the server: a session replaced or a main demoted meanwhile writes nothing (r2-F005).
			if (me() !== id || !ownsBoard(role())) throw new Error(`Nothing was snoozed: ${NOT_MAIN}`);
			if (!watched?.ok) throw new Error("Nothing was snoozed: no sb server answers this session, and the server is what reminds and reads the snooze (/boss server shows it)");
			if (watched.snoozes === false) throw new Error("Nothing was snoozed: the sb server of this Herdr slot does not run the stale reminder (the primary server does, for the mains of its own Herdr), so this main gets none to snooze");
			if (watched.snoozes !== true) throw new Error("Nothing was snoozed: the sb server runs an older pi-straw-boss, which ignores snoozes. Restart it on this version (/boss server restart), then snooze again");
			restore(id);
			const { list } = listed(), s = snoozeOf(input, { now: cfg.now(), watches: ((watched?.watches ?? []) as { key: string }[]).map((w) => w.key), open: list.filter((t) => t.status !== "completed").map((t) => t.id) });
			const before = snoozes;
			snoozes = withSnooze(snoozes, s);
			last = undefined;
			try { refresh(true); } catch (error) { snoozes = before; throw error; }
			return { text: snoozeSaid(s, cfg.now()), details: { snooze: s } };
		},
	};
}
