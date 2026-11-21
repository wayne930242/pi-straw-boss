import { type Ctx, trusted } from "./client.ts";
import { callControl, type Reply } from "./socket.ts";

// `cli.mjs watch <key>` (docs/specs/2026-11-21-box-mac-waits.md §5, item D): the `watch-read` loop of a watchdog child, run as a command a standing main starts under `MonitorCreate`. It prints one JSON line per verdict other than
// `unchanged`, chaining `since`, so the monitor wakes the main only on a line and the main polls nothing in its own turns. It ends with 0 on `gone` or `expired` (or a signal), 1 on an unknown key, 2 on a usage error. While the server does
// not answer it asks again every 5 s and prints `{"server":"unreachable"}` once per such spell.

export interface WatchIo {
	out(text: string): void;
	err(text: string): void;
	/** One `watch-read` request; a test gives a fake. Undefined: the server was not reached. */
	call?(request: Record<string, unknown>): Promise<Reply | undefined>;
	sleep?(ms: number): Promise<void>;
	signal?: AbortSignal;
}
const RETRY_MS = 5000, REQUEST_MS = 60_000;
/** A length: `90s`, `20m`, `2h`, or plain milliseconds. */
export function durationMs(text: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
	if (!m) return undefined;
	return Math.round(Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "ms") as "ms"]);
}

export async function runWatch(ctx: Ctx | undefined, flags: Record<string, string | true>, io: WatchIo): Promise<number> {
	const key = String(flags.key ?? ""), idleMs = flags.idle === undefined ? undefined : durationMs(String(flags.idle)), quietMs = flags.quiet === undefined ? undefined : durationMs(String(flags.quiet));
	const deadline = flags.deadline === undefined ? undefined : Number(flags.deadline);
	if (!key || key.length > 200) return (io.err("watch needs a key of 1 to 200 characters\n"), 2);
	if (idleMs !== undefined && !(idleMs >= 60_000)) return (io.err("--idle is at least 1m (20m, 90s, or milliseconds)\n"), 2);
	if (quietMs !== undefined && !(quietMs >= 60_000)) return (io.err("--quiet is at least 1m (30m, 90s, or milliseconds)\n"), 2);
	if (deadline !== undefined && !(Number.isFinite(deadline) && deadline > 0)) return (io.err("--deadline is a time in epoch ms\n"), 2);
	const call = io.call ?? (async (request: Record<string, unknown>) => {
		const record = ctx ? await trusted(ctx).catch(() => undefined) : undefined;
		if (!record || !ctx!.alive(record.pid)) return undefined;
		return (await callControl(record.socket, record.secret, request as { cmd: string }, REQUEST_MS).catch(() => ({ reply: undefined }))).reply;
	});
	const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
	let since: string | undefined, lost = false;
	while (!io.signal?.aborted) {
		const reply = await call({ cmd: "watch-read", key, ...(since ? { since } : {}), ...(idleMs ? { idleMs } : {}), ...(quietMs ? { quietMs } : {}), ...(deadline ? { deadline } : {}) });
		if (!reply?.ok) {
			const error = typeof reply?.error === "string" ? reply.error : undefined;
			if (error?.startsWith("unknown key") || error?.includes("is at least") || error?.startsWith("key is")) return (io.err(`${error}\n`), 1);
			if (!lost) io.out(`${JSON.stringify({ server: "unreachable", ...(error ? { error } : {}) })}\n`);
			lost = true;
			await sleep(RETRY_MS);
			continue;
		}
		lost = false;
		if (typeof reply.since === "string") since = reply.since;
		if (reply.state === "unchanged") continue;
		const { ok: _ok, since: _since, ...line } = reply;
		io.out(`${JSON.stringify({ key, ...line })}\n`);
		if (reply.state === "gone" || reply.state === "expired") return 0;
	}
	return 0;
}
