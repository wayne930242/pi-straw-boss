// What a run token may ask of the control socket (docs/specs/2026-10-26-sb-backend.md, The control socket, Security: New guards; B3R-F003). A request without a token is a session's or a shell's, and the hello
// secret is its credential, as before. A request that carries a run token is a run's: the server looks the token up and holds the request to the run's kind. A local run is the tower itself, so it may do
// what a tower does (read the status, ask the link holder for a list, a board, a send, or an approved request, open and close mains of its own workspace); an ally run is a peer's message at a
// level, so it may do almost nothing (B6 widens it with the gate). Neither kind administers the GUI, the link team, the tower's tab, or the server.

export type Kind = "local" | "ally";
export interface RunInfo { id: string; workspace: string; kind: Kind }
export type Verdict = { ok: true } | { ok: false; error: string };

/** The link holder ops a local run may send: reading, sending as its own tower, and the approved `link_request` flow. Everything else is the boss's. */
export const LOCAL_LINK_OPS = ["list", "board-read", "send", "confirms", "request-open", "request-run", "request-drop"] as const;
/** Commands that carry a run's own token as their credential (runs.ts): the token is checked there. */
const OWN_TOKEN = new Set(["run-poll", "run-taken", "run-done", "run-release", "run-file", "run-tool"]);
const LOCAL_ONLY_OWN_WORKSPACE = new Set(["open-main", "close-main"]);
const LOCAL_READS = new Set(["status"]);

const no = (error: string): Verdict => ({ ok: false, error });
export function gateRun(request: { cmd: string; workspace?: unknown; body?: unknown }, run: RunInfo): Verdict {
	const { cmd } = request;
	if (OWN_TOKEN.has(cmd)) return { ok: true };
	if (run.kind === "ally") return no(`an ally run's token may not ask for ${cmd}`);
	if (LOCAL_READS.has(cmd)) return { ok: true };
	if (LOCAL_ONLY_OWN_WORKSPACE.has(cmd)) return request.workspace === run.workspace ? { ok: true } : no(`a run token may ${cmd} only for its own workspace (${run.workspace})`);
	if (cmd === "link") {
		const op = (typeof request.body === "object" && request.body !== null ? (request.body as { op?: unknown }).op : undefined);
		return (LOCAL_LINK_OPS as readonly unknown[]).includes(op) ? { ok: true } : no(`a run token may not send the link request ${String(op)}: the team is the boss's to administer`);
	}
	return no(`a run token may not ask for ${cmd}`);
}
