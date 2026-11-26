import { resolve } from "node:path";
import { type Ctx, trusted } from "./client.ts";
import { callControl, ControlError } from "./socket.ts";

// `cli.mjs procs`: the owner registry of the running server (procs.ts). `procs` lists the workers it knows, `procs reap` kills what an ended one left. Kept out of cli.ts, which carries a line budget.
// Exit codes: 0 done; 1 the server was not reached, the request was refused or failed, or `reap` left a process alive (the JSON on stdout says which).

export interface ProcsIo { out(value: unknown): void; err(text: string): void }
/** The registry's answer without its `ok`, or why there is none. */
export type Asked = { ok: true; reply: Record<string, unknown> } | { ok: false; error: string };

/** One request to the registry of the running server (`pane close` asks its `procs-reap --checkout` here too). */
export async function askProcs(ctx: Ctx, request: { cmd: string } & Record<string, unknown>): Promise<Asked> {
	const record = await trusted(ctx);
	if (!record || !ctx.alive(record.pid)) return { ok: false, error: "no sb server is running, so there is no owner registry to ask" };
	let reply: Awaited<ReturnType<typeof callControl>>["reply"];
	try {
		reply = (await callControl(record.socket, record.secret, request, 60_000)).reply;
	} catch (error) {
		// A request that was written may have been carried out (a reap in progress when the wait ran out): the caller must look before it sends the request again.
		return { ok: false, error: error instanceof ControlError && error.sent ? `the server took the request but did not answer in time (${error.message}); it may still be running: check with \`procs\` before asking again` : `the server did not take the request: ${(error as Error).message}` };
	}
	if (!reply?.ok) return { ok: false, error: String(reply?.error ?? "no answer") };
	const { ok: _ok, ...rest } = reply;
	return { ok: true, reply: rest };
}

export async function runProcs(ctx: Ctx, flags: Record<string, string | true>, { out, err }: ProcsIo): Promise<number> {
	const asked = await askProcs(ctx, flags.sub === "reap" ? { cmd: "procs-reap", ...(flags.owner !== undefined ? { owner: String(flags.owner) } : { checkout: resolve(String(flags.checkout)) }) } : { cmd: "procs-list" });
	if (!asked.ok) return (err(`${asked.error}\n`), 1);
	out(asked.reply);
	return Array.isArray(asked.reply.left) && asked.reply.left.length > 0 ? 1 : 0;
}
