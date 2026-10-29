import { callControl, ControlError } from "./socket.ts";
import { type Ctx, decide, ensure, lockWaitFor, probe, restart, ServerError } from "./client.ts";

// How a session, a sidecar, or a handing-over resident tower asks the sb server for a workspace's tower (docs/specs/2026-10-26-sb-backend.md, A workspace gets one):
// `ensure-tower` over the control socket. The server makes the tab, registers the identity, and writes the tokens; it starts no pi. Only behind `towerRuns.enabled`.

export const STOPPED = "the sb server was stopped on purpose; /boss server starts it again";
/** What the server answers `ensure-tower` with. `resident`: a tower of an older build holds the workspace and is the tower until it leaves. */
export interface TowerAnswer { id: string; workspace: string; label: string; tab?: string; pane?: string; opened: boolean; resident?: boolean; live: boolean }
export interface TowerAsk {
	workspace: string;
	/** The folder the tab opens in when the workspace has no checkout path. */
	cwd?: string;
	/** A pane the server takes as the standing pane: a resident tower of this build hands over the pane it runs in. */
	pane?: string;
	/** The PID of the resident tower that hands the pane over: the server types nothing into the pane until that process is gone. */
	pid?: number;
	/** The boss's own command (`/boss tower`): it clears a stop on purpose and starts the server. Anything else fails against a stopped server. */
	boss?: boolean;
	/** How long the ask waits for the server's answer (30 s by default). */
	ms?: number;
}

/** Waits for a server that is restarting, starts one that is down (the boss's command may start a stopped one), and returns the record to ask. */
async function serverFor(ctx: Ctx, boss: boolean) {
	const end = ctx.now() + lockWaitFor(ctx);
	for (;;) {
		const seen = await probe(ctx), verdict = decide(ctx, seen);
		if (verdict.do === "refuse") throw new Error(verdict.text);
		if (seen.denied) throw new Error("the sb server runs but this process may not reach it (started from an elevated shell?)");
		if (seen.live && seen.record) {
			// A server on an older package than this one is upgraded by a session's look, not by a tower request.
			if (verdict.do === "upgrade") {
				// The new server has its own record and secret: the old record answers nothing.
				const done = await restart(ctx, { reason: "upgrade", upgrade: true, lockWaitMs: 0 }).catch(() => undefined);
				return done?.record ?? seen.record;
			}
			return seen.record;
		}
		if (seen.record?.stopped && !boss) throw new Error(STOPPED);
		if (verdict.do === "nothing" && verdict.why === "restarting" && ctx.now() < end) {
			await ctx.sleep(250);
			continue;
		}
		try {
			const done = await ensure(ctx, { boss, lockWaitMs: lockWaitFor(ctx) });
			if ("skipped" in done) {
				if (ctx.now() >= end) throw new Error(`the sb server is not running (${done.skipped.do === "nothing" ? done.skipped.why : done.skipped.do})`);
				if (done.skipped.do === "nothing" && done.skipped.why === "stopped") throw new Error(STOPPED);
				await ctx.sleep(250);
				continue;
			}
			return done.record;
		} catch (error) {
			if (error instanceof ServerError && error.code === "busy" && ctx.now() < end) continue;
			throw error;
		}
	}
}

/** Asks the server for the tower of a workspace. Rejects with the server's own words when it refuses (the flag is off, no such workspace), or with why no server could be reached. */
export async function ensureTowerVia(ctx: Ctx, ask: TowerAsk): Promise<TowerAnswer> {
	const record = await serverFor(ctx, ask.boss === true);
	try {
		const { reply } = await callControl(record.socket, record.secret, { cmd: "ensure-tower", workspace: ask.workspace, ...(ask.cwd ? { cwd: ask.cwd } : {}), ...(ask.pane ? { pane: ask.pane } : {}), ...(ask.pid !== undefined ? { pid: ask.pid } : {}) }, ask.ms ?? 30_000);
		if (!reply?.ok) throw new Error(`the sb server did not give the tower of ${ask.workspace}: ${String(reply?.error ?? "no answer")}`);
		const { ok: _ok, ...answer } = reply;
		// SAFETY: the server's `ensure-tower` reply carries exactly these fields (src/server/towers.ts, Ensured).
		return answer as unknown as TowerAnswer;
	} catch (error) {
		if (error instanceof ControlError) throw new Error(`the sb server did not answer: ${error.message}`);
		throw error;
	}
}
