import { join } from "node:path";
import { capDir, capOfTodos, type MainCap, PAUSE_EVENT, type Pause, pauseOf, readCaps, removeCap, writeCap } from "./capacity.ts";
import { todosOf } from "./items.ts";
import type { Kit } from "./state.ts";
import { snapshotScan } from "./todo.ts";
import { ownsBoard } from "./trainrole.ts";

// A main's capacity facts (docs/specs/2026-11-24-capacity.md): its own session writes `<state dir>/capacity/<session>.json` from its todo list (read as the board's auto-fill reads it) and from the pause seam, whenever
// either changes. The seam is `straw-boss:pause` on pi's in-process event bus, which pi-agent-basic's quota resume emits in the session that stopped; nothing of basic is imported. A pause clears on `resumed` or when
// the session starts a new turn. The sb server joins the files with what runs (server/capwatch.ts).

export function createCapFill({ pi, cfg, guiDir, me, role }: Kit): { refresh(): void } {
	const dir = capDir(join(guiDir, "board")), snapshotOf = snapshotScan();
	let ctx: { sessionManager?: { getBranch(): readonly unknown[] } } | undefined, pause: Pause | undefined, last: string | undefined, wrote: string | undefined, restored = false;
	const branch = (): readonly unknown[] => { try { return ctx?.sessionManager?.getBranch() ?? []; } catch { return []; } }; // a replaced session's context throws
	const refresh = () => {
		const id = me();
		if (!id || !ownsBoard(role())) return;
		try {
			// A /reload keeps the pause its file holds (the model is still stopped); read once, when the session's id is known (pi-intercom may set it after the start).
			if (!restored) (restored = true), (pause ??= readCaps(dir).find((x) => x.session === id)?.pause);
			const snapshot = snapshotOf(branch()), facts = capOfTodos(todosOf(snapshot) ?? [], snapshot), key = JSON.stringify([facts, pause ?? null]);
			if (key === last && wrote === id) return;
			const cap: MainCap = { v: 1, session: id, updated: cfg.now(), ...facts, ...(pause ? { pause } : {}) };
			writeCap(dir, cap);
			[last, wrote] = [key, id];
		} catch { /* the board folder cannot be written: the next change tries again */ }
	};
	const again = (c: unknown) => ((ctx = (c as typeof ctx) ?? ctx), refresh());
	pi.events?.on(PAUSE_EVENT, (data) => {
		const said = pauseOf(data, cfg.now());
		if (!said) return;
		pause = said.state === "paused" ? said.pause : undefined;
		refresh();
	});
	pi.on("session_start", (_e, c) => ((last = undefined), (restored = false), (pause = undefined), again(c)));
	pi.on("turn_start", (_e, c) => ((pause = undefined), again(c)));
	pi.on("turn_end", (_e, c) => again(c));
	pi.on("tool_execution_end", (_e, c) => again(c)); // the todo tool ends here
	pi.on("session_tree", (_e, c) => again(c));
	pi.on("session_compact", (_e, c) => again(c));
	pi.on("session_shutdown", (event) => {
		if ((event as { reason?: string }).reason !== "reload" && wrote) removeCap(dir, wrote);
	});
	return { refresh };
}
