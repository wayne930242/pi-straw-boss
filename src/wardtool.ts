import { Type } from "typebox";
import type { Control } from "./closemain.ts";
import type { Ask } from "./host.ts";
import type { Reach } from "./reach.ts";
import { towerRunsEnabled } from "./server/towerruns.ts";
import type { Kit } from "./state.ts";

// `sb_ward` (docs/how-it-works.md#ward-a-plain-pane): a main hands the sb server a worker that runs in a plain pane, and the server wakes it only when the worker finished, is blocked, or is dead (server/ward.ts). The ward is a
// watch of the server's (key `ward:<pane>`), so its line comes as boss_watch's do (bosswatch.ts takes it on the control channel), boss_watch lists it, and boss_watch with stop ends it as sb_ward with stop does. The main's
// session keeps a `sb-ward` entry of each ward it set: the pane, the worker's session file, and the item.

export const WARD_ENTRY = "sb-ward";
export const WARD_DESCRIPTION = "Ward a worker in a plain pane instead of a herdr monitor: the sb server wakes you once when it finished (reported to you, or its turn ended and nothing of it ran for a minute), is blocked (a dialog, or Herdr blocked), or is dead (pane gone, pi left). Read only.";

export function createWard({ pi, cfg, s, guiDir, me, role }: Kit, d: { ask?: Ask; control: Pick<Control, "register">; openTower: Reach["openTower"]; remote(): boolean }) {
	const ask = async (request: Record<string, unknown>) => {
		if (!d.ask) throw new Error("No sb server answers this session");
		const reply = await d.ask(request, { start: "auto" });
		if (!reply.ok) throw new Error(String(reply.error ?? "the sb server refused"));
		return reply;
	};
	let registered = false;
	// Registered at the join with the other net tools, and active only while the session is a main (as call_peer follows its roles, callpeer.ts).
	pi.on("before_agent_start", () => {
		if (!registered) return;
		const active = pi.getActiveTools(), want = role() === "main" && !s.isTower ? [...new Set([...active, "sb_ward"])] : active.filter((name) => name !== "sb_ward");
		if (want.length !== active.length) pi.setActiveTools(want);
	});
	return {
		/** With the net tools of a joined session that is no tower. */
		addTool() {
			if (registered) return;
			registered = true;
			pi.registerTool({
				name: "sb_ward", label: "sb_ward", description: WARD_DESCRIPTION, defaultActive: false,
				parameters: Type.Object({
					pane: Type.String(),
					item: Type.Optional(Type.String({ description: "MP-123" })),
					until: Type.Optional(Type.String({ description: "2h; default 6h" })),
					stop: Type.Optional(Type.Boolean()),
				}),
				execute: async (_id, { pane, item, until, stop }) => {
					if (s.isTower || role() !== "main") throw new Error("Only a tab's main wards a worker; a train or a member reports to its main");
					if (s.remoteOrigin || d.remote()) throw new Error("A teammate's turn cannot set this main's wards");
					const key = `ward:${pane.trim()}`, reply = (text: string, details: unknown) => ({ content: [{ type: "text" as const, text }], details });
					if (stop) return (await ask({ cmd: "watch-stop", session: me(), key }), reply(`Stopped warding ${pane}.`, { pane, stopped: true }));
					if (!towerRunsEnabled(cfg.stateDir ?? guiDir)) throw new Error("tower runs are off on this computer (towerRuns.enabled is false): the ward's wake is sent by the workspace's tower identity of the sb server");
					const ms = until === undefined ? undefined : ((m) => (m ? Math.round(Number(m[1]) * { m: 60_000, h: 3_600_000 }[m[2] as "m" | "h"]) : NaN))(/^(\d+(?:\.\d+)?)(m|h)$/.exec(until.trim()));
					if (ms !== undefined && !(ms >= 60_000 && ms <= 48 * 3_600_000)) throw new Error("until is 1m to 48h: 90m, 2h");
					await d.openTower(undefined, true); // the workspace's tower identity sends the wake, as it does boss_watch's lines
					try { d.control.register(); } catch (error) { throw new Error(`sb_ward cannot listen for the server's wake: ${(error as Error).message}`); }
					const names = [pi.getSessionName(), s.ownName].filter((n): n is string => typeof n === "string" && n.trim().length > 0);
					const added = await ask({ cmd: "watch-add", session: me(), workspace: s.at.workspaceId, key, ...(ms ? { untilMs: ms } : {}), ward: { ...(item ? { item: item.trim() } : {}), names, ...(cfg.env.HERDR_PANE_ID ? { here: cfg.env.HERDR_PANE_ID } : {}) } });
					const watch = added.watch as { until: number; line: string }, ward = added.ward as { pane: string; file: string; item?: string };
					try { pi.appendEntry(WARD_ENTRY, { ward: ward.pane, sessionFile: ward.file, ...(ward.item ? { item: ward.item } : {}) }); } catch { /* a replaced session's pi throws */ }
					return reply(`Warding ${ward.pane} (session ${ward.file}) until ${new Date(watch.until).toTimeString().slice(0, 5)}. Now: ${watch.line} You get one message when it finishes, blocks, or dies, after your turn while you work; do not poll it in your own turns. sb_ward with stop ends it.`, { ...ward, until: watch.until });
				},
			});
		},
	};
}
