// A stand-in program that does not end when it is told to, for the tests of a deadline (todo #155): herdr.test.ts, exe.test.ts, balance.test.ts, reaper.test.ts.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Twenty seconds of a shell's own, then the mark that it was left to end by itself. */
export const LINGER = `i=0\nwhile [ $i -lt 200 ]; do sleep 0.1; i=$((i + 1)); done\n: > "$1/outlived"`;
/** A program that ignores SIGTERM, says a word, leaves its pid, and lingers. */
export const STUBBORN = `trap '' TERM\necho started\necho $$ > "$1/pid"\n${LINGER}`;
export const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
export interface Cut { killed?: boolean; signal?: unknown; code?: unknown }
/** The marks of a command cut off at its deadline, which are those of execFile's timeout. */
export const cutOff = (error: Cut) => error.killed === true && error.signal === "SIGTERM" && typeof error.code !== "number";
/** Shell scripts in a folder of their own, `herdr` among them and on HERDR_BIN_PATH; the first argument of a call names the folder, so a script leaves its pid and its mark there. */
export function standIn(scripts: Record<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), "psb-herdr-")), before = process.env.HERDR_BIN_PATH;
	for (const [name, body] of Object.entries(scripts)) writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	process.env.HERDR_BIN_PATH = join(dir, "herdr");
	const has = (name: string) => existsSync(join(dir, name)), pid = (name: string) => Number(readFileSync(join(dir, name), "utf8"));
	return {
		dir, bin: join(dir, "herdr"), has, pid,
		close: () => {
			if (before === undefined) delete process.env.HERDR_BIN_PATH;
			else process.env.HERDR_BIN_PATH = before;
			for (const name of ["pid", "held"]) try { process.kill(pid(name), "SIGKILL"); } catch { /* gone, or never written */ }
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
/** A stand-in that starts a child with its own stdout and stderr, which ignores SIGTERM and lingers; the stand-in itself waits for it, or (`leave`) says a word and exits. */
export const withChild = () => standIn({
	herdr: `"$1/holder" "$1" &\nwhile [ ! -s "$1/held" ]; do sleep 0.05; done\necho $$ > "$1/pid"\nif [ "$2" = leave ]; then echo left; exit 0; fi\nwait`,
	holder: `trap '' TERM\necho $$ > "$1/held"\n${LINGER}`,
});
