import { homedir } from "node:os";
import { join } from "node:path";
import { panes } from "./herdr.ts";
import type { Ask } from "./host.ts";
import { subagents } from "./netdata.ts";
import { armedLoop } from "./server/capops.ts";
import type { Kit } from "./state.ts";

// What still runs for this session, the one probe the idle nudge, the standing main's wake (docs/specs/2026-11-26-standing-prompt.md), boss_wrap, and the close of an old main that handed over (rotclose.ts) ask:
// a dialog or monitor, a loop, a boss_watch watch, a subagent, and a pane Herdr shows blocked. Each answer is the list of reasons; none means nothing runs.

export interface ProbeDeps {
	/** What a stop would lose that an abort does not end (bridge.ts): an open dialog, a running monitor. */
	blockers(): string | undefined;
	ask?: Ask;
	/** pi-loop-monitor's folder (`~/.pi/loops`). */
	loopsDir?: string;
}

export function createProbe({ cfg, s, me }: Pick<Kit, "cfg" | "s" | "me">, d: ProbeDeps) {
	/** `pane`: a pane Herdr shows blocked counts; `sure`: a watch list that does not answer counts too (T4 review F002), and so does a pane list that fails or lacks this pane. */
	const why = async (pane: boolean, sure: boolean): Promise<string[]> => {
		const out: string[] = [];
		const b = d.blockers();
		if (b) out.push(b);
		if (armedLoop(d.loopsDir ?? join(homedir(), ".pi", "loops"), me(), cfg.now())) out.push("a loop is active");
		const watches = await d.ask?.({ cmd: "watch-list", session: me() }, { start: "never" }).catch(() => undefined);
		if (watches?.ok && Array.isArray(watches.watches) && watches.watches.length) out.push(`${watches.watches.length} boss_watch watch${watches.watches.length > 1 ? "es run" : " runs"} (boss_watch stop ends one)`);
		else if (sure && !(watches?.ok && Array.isArray(watches.watches))) out.push("the watch list does not answer");
		const all = await panes(cfg.run).catch(() => undefined), mine = all?.find((p) => p.pane_id === s.at?.paneId);
		if (sure && !mine) out.push("Herdr's pane list did not answer or lacks this pane"); // its subagents are unknown (RV6-F001)
		const kids = all ? subagents(mine, all, cfg.now()).filter((r) => !r.ended).length : 0;
		if (kids) out.push(`${kids} subagent${kids > 1 ? "s are" : " is"} running`);
		if (pane && mine?.agent_status === "blocked") out.push("this pane waits on a dialog");
		return out;
	};
	return {
		/** The idle nudge: a read that fails counts as nothing there. */
		nudge: () => why(true, false),
		/** The standing main's wake and the old main's close: a read that fails counts as running. */
		strict: () => why(true, true),
		/** boss_wrap's checks: its own dialog is the pane's, so a blocked pane does not count. */
		wrap: () => why(false, false),
	};
}
export type Probe = ReturnType<typeof createProbe>;
