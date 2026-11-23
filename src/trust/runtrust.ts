import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trustReaders } from "./ask.ts";

// pi's project-trust question in a headless tower run (docs/specs/2026-11-23-f-entry.md §2.6). RPC mode cannot draw pi's own prompt, and its trust context has no UI (`hasUI` false; a confirm there answers no at
// once, measured on pi 1.3.0 and 1.6.0), so with no saved decision and `defaultProjectTrust` "ask" pi would skip the folder's project settings and extensions without a word. The run asks the sb server instead
// (`run-trust`, with the PID and nonce its claim will carry), which shows the question as the run's dialog in the viewers and on this computer's page, where only the boss answers it (runs.ts `trust`). A yes
// trusts the folder for this run only, never remembered; a no, or no answer within the dialog's minute, leaves pi's order as it was.

type Ask = (request: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; [key: string]: unknown }>;

/** The run id the server started this pi with: pi parses an extension's flags only after the trust question, so `--sb-run` is read from the command line here. */
export const runOf = (argv: readonly string[]) => ((at) => (at >= 0 && /^[0-9a-f]{8,64}$/.test(argv[at + 1] ?? "") ? argv[at + 1] : undefined))(argv.indexOf("--sb-run"));

export function registerRunTrust(pi: ExtensionAPI, ask: Ask, env: NodeJS.ProcessEnv, readers = trustReaders(), argv: readonly string[] = process.argv): void {
	pi.on("project_trust", async (event) => {
		const undecided = { trusted: "undecided" as const }, runId = runOf(argv);
		if (typeof runId !== "string" || !runId || !env.STRAW_BOSS_RUN_NONCE) return undecided;
		try {
			if (readers.saved(event.cwd) !== null || readers.defaultTrust(event.cwd) !== "ask") return undecided; // pi decides as it would anyway
		} catch {
			return undecided; // a broken trust.json: pi reports it itself
		}
		const answer = await ask({ cmd: "run-trust", runId, pid: process.pid, nonce: env.STRAW_BOSS_RUN_NONCE, cwd: event.cwd }).catch(() => undefined);
		return answer?.ok === true && answer.trusted === true ? { trusted: "yes" as const } : undecided;
	});
}
