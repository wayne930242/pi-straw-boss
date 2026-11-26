import { type HerdrRun, panes } from "../herdr.ts";
import type { Ctx } from "./client.ts";
import { askProcs, type Asked } from "./procscli.ts";

// `cli.mjs ward PANE [--item ID] [--until 2h] [--stop]` (docs/how-it-works.md#ward-a-plain-pane): `sb_ward` from a main's shell. The ward is for the session that runs the shell (PI_INTERCOM_SESSION_ID, which a pi session's
// shell inherits) in the workspace of its pane (HERDR_PANE_ID); the server keeps it as sb_ward's (server/ward.ts). The wake reaches that session once it listens on the control channel: after it called sb_ward or boss_watch, or
// at its next join or /reload, when the server holds a watch of it. Exit codes: 0 the ward is set or ended; 1 refused; 2 usage.

export interface WardIo { out(text: string): void; err(text: string): void; env: NodeJS.ProcessEnv; run: HerdrRun; ask?(request: { cmd: string } & Record<string, unknown>): Promise<Asked> }
export async function runWard(ctx: Ctx, flags: Record<string, string | true>, io: WardIo): Promise<number> {
	const ask = io.ask ?? ((request) => askProcs(ctx, request));
	const session = io.env.PI_INTERCOM_SESSION_ID, here = io.env.HERDR_PANE_ID, key = `ward:${String(flags.pane)}`;
	if (!session) return (io.err("ward needs PI_INTERCOM_SESSION_ID: run it from the shell of the main's pi session, or call sb_ward\n"), 1);
	if (flags.stop === true) {
		const r = await ask({ cmd: "watch-stop", session, key });
		return r.ok ? (io.out(`${JSON.stringify({ pane: flags.pane, stopped: true })}\n`), 0) : (io.err(`${r.error}\n`), 1);
	}
	const until = typeof flags.until === "string" ? ((m) => (m ? Math.round(Number(m[1]) * { m: 60_000, h: 3_600_000 }[m[2] as "m" | "h"]) : NaN))(/^(\d+(?:\.\d+)?)(m|h)$/.exec(flags.until.trim())) : undefined;
	if (until !== undefined && !(until >= 60_000 && until <= 48 * 3_600_000)) return (io.err("--until is 1m to 48h: 90m, 2h\n"), 2);
	const workspace = here ? (await panes(io.run).catch(() => [])).find((p) => p.pane_id === here)?.workspace_id : undefined;
	if (!workspace) return (io.err("ward runs in the main's pane (HERDR_PANE_ID), whose workspace Herdr must list\n"), 1);
	const r = await ask({ cmd: "watch-add", session, workspace, key, ...(until ? { untilMs: until } : {}), ward: { ...(typeof flags.item === "string" ? { item: flags.item } : {}), here } });
	if (!r.ok) return (io.err(`${r.error}\n`), 1);
	io.out(`${JSON.stringify({ ...(r.reply.ward as object), until: (r.reply.watch as { until?: number })?.until, now: (r.reply.watch as { line?: string })?.line })}\n`);
	return 0;
}
