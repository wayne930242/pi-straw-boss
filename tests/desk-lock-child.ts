// A child of the multi-process desk.lock test (server-desk.test.ts): waits for the shared start time, takes desk.lock (trying again while it is busy), holds it for a moment, and logs `in`/`out` lines.
import { appendFileSync } from "node:fs";
import { alive } from "../src/remote.ts";
import { deskLockFor } from "../src/server/desk.ts";
import { slotOf } from "../src/server/record.ts";

const [stateDir, log, startAt, holdMs] = process.argv.slice(2) as [string, string, string, string];
const slot = slotOf(stateDir, { ...process.env, HERDR_SOCKET_PATH: undefined, HERDR_SESSION: undefined }) /* the primary slot: its files lie in the state folder itself */, ctx = { slot, now: Date.now, alive };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const gate = setTimeout(() => process.exit(3), 30_000); // a child that must exit on its own
await pause(Math.max(0, Number(startAt) - Date.now()));
for (;;) {
	const release = await deskLockFor(ctx);
	if (release) {
		appendFileSync(log, `in ${process.pid}\n`);
		await pause(Number(holdMs));
		appendFileSync(log, `out ${process.pid}\n`);
		release();
		break;
	}
	await pause(3);
}
clearTimeout(gate);
