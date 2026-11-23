import { Type } from "typebox";
import type { Control } from "./closemain.ts";
import type { Ask } from "./host.ts";
import { workspaces } from "./herdr.ts";
import type { Reach } from "./reach.ts";
import { towerRunsEnabled } from "./server/towerruns.ts";
import type { Kit } from "./state.ts";

// `boss_watch` (docs/specs/2026-11-23-lite-b2-d-e-f.md §3.3; boss decisions e_ask=tool, e_busy=followup): a main or a train asks the sb server to watch one unit of the net, and the server wakes it with one line per change
// (server/watches.ts), sent as the workspace's tower identity on the `straw-boss/control` channel (closemain.ts). The line is taken only from that identity, and lands as one custom message that waits for the end of a busy turn (a
// follow-up) or starts a turn when the main is idle; it never steers. The channel registers at the first `boss_watch` and at each join that finds a watch of this session on the server, so a /reload keeps receiving.

export const WATCH_MESSAGE = "straw-boss-watch";
export const WATCH_DESCRIPTION = "Have the sb server watch one unit of the net and wake you when it changes, instead of checking in your own turns. key: a main's, train's, or subagent's key or session id, or a teammate device's link:<short>[/<unit>|/main/<handle>]. You get one line per change of state (mark, a monitor's status or exit, todo progress, a train's step, its subagents), stalled (no activity for quiet), idle (idle that long), a link wait, offline, gone (it ended), or expired (until): at most one a minute per watch, the newest state only, 12 an hour; while you work it waits for the end of your turn. stop: end it. No key: list your watches. Main or train only.";
const MIN_MS = 60_000, MAX_MS = 48 * 3_600_000;

/** A length: `90s`, `20m`, `2h`, or plain milliseconds. */
export function durationMs(text: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
	if (!m) return undefined;
	return Math.round(Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "ms") as "ms"]);
}
const span = (name: string, text: string | undefined): number | undefined => {
	if (text === undefined) return undefined;
	const ms = durationMs(text);
	if (ms === undefined || ms < MIN_MS) throw new Error(`${name} is at least 1m (30m, 90s, 2h)`);
	if (ms > MAX_MS) throw new Error(`${name} is at most 48h`);
	return ms;
};

export function createBossWatch({ pi, cfg, s, guiDir, me, role }: Kit, d: { ask?: Ask; control: Pick<Control, "register" | "onWatch">; openTower: Reach["openTower"]; remote(): boolean }) {
	d.control.onWatch(async (from, p) => {
		const mine = (await workspaces(cfg.run)).find((w) => w.workspace_id === s.at.workspaceId);
		if (!mine?.tokens?.tower || mine.tokens.tower !== from || typeof p.text !== "string") return false;
		pi.sendMessage({ customType: WATCH_MESSAGE, content: p.text.slice(0, 1000), display: true, details: { key: p.key, state: p.state } }, { triggerTurn: true, deliverAs: "followUp" });
		return true;
	});
	const ask = async (request: Record<string, unknown>) => {
		if (!d.ask) throw new Error("No sb server answers this session");
		const reply = await d.ask(request, { start: "auto" });
		if (!reply.ok) throw new Error(String(reply.error ?? "the sb server refused"));
		return reply;
	};
	return {
		/** With the net tools of a joined session that is no tower; a session the server holds a watch for listens again. */
		addTool() {
			void d.ask?.({ cmd: "watch-list", session: me() }, { start: "never" }).then((r) => void (r.ok && Array.isArray(r.watches) && r.watches.length && d.control.register()), () => {});
			pi.registerTool({
				name: "boss_watch", label: "boss_watch", description: WATCH_DESCRIPTION,
				parameters: Type.Object({
					key: Type.Optional(Type.String({ description: "The unit's key or session id, or link:<short>…; none lists your watches." })),
					quiet: Type.Optional(Type.String({ description: "stalled after this long without activity: 30m, 2h (at least 1m)." })),
					idle: Type.Optional(Type.String({ description: "idle after this long idle (at least 1m)." })),
					until: Type.Optional(Type.String({ description: "How long the watch lasts. Default 6h, at most 48h." })),
					stop: Type.Optional(Type.Boolean({ description: "true: end the watch on key." })),
				}),
				execute: async (_id, { key, quiet, idle, until, stop }) => {
					if (s.isTower || role() === "tower") throw new Error("A tower does not watch: the head tower's auto-watch is its watch");
					if (role() !== "main" && role() !== "train") throw new Error("Only a tab's main or a train watches; call boss_promote first if your work grows");
					if (s.remoteOrigin || d.remote()) throw new Error("A teammate's turn cannot set this main's watches");
					const reply = (text: string, details: unknown) => ({ content: [{ type: "text" as const, text }], details });
					if (key === undefined) {
						const rows = (await ask({ cmd: "watch-list", session: me() })).watches as { key: string; until: number; newest?: { line: string } }[];
						return reply(rows.length ? rows.map((r) => `- ${r.newest?.line ?? `watch ${r.key}`} (until ${new Date(r.until).toTimeString().slice(0, 5)})`).join("\n") : "You watch nothing.", { watches: rows });
					}
					if (stop) return (await ask({ cmd: "watch-stop", session: me(), key }), reply(`Stopped watching ${key}.`, { key, stopped: true }));
					if (!towerRunsEnabled(cfg.stateDir ?? guiDir)) throw new Error("tower runs are off on this computer (towerRuns.enabled is false): boss_watch needs the workspace's tower identity of the sb server, which sends the wakes. Watch with MonitorCreate instead");
					const quietMs = span("quiet", quiet), idleMs = span("idle", idle), untilMs = span("until", until);
					await d.openTower(undefined, true); // the workspace's tower identity sends the lines, as it carries call_tower
					try { d.control.register(); } catch (error) { throw new Error(`boss_watch cannot listen for the server's lines: ${(error as Error).message}`); }
					const added = (await ask({ cmd: "watch-add", session: me(), workspace: s.at.workspaceId, key, ...(quietMs ? { quietMs } : {}), ...(idleMs ? { idleMs } : {}), ...(untilMs ? { untilMs } : {}) })).watch as { until: number; line: string };
					return reply(`Watching ${key} until ${new Date(added.until).toTimeString().slice(0, 5)}. Now: ${added.line}. Each change comes to you as one message, after your turn while you work; do not poll it in your own turns. boss_watch with stop ends it.`, { key, until: added.until });
				},
			});
		},
	};
}
