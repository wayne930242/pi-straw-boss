// What a run token may ask of the control socket (docs/specs/2026-10-26-sb-backend.md, The control socket, Security: New guards; B3R-F003). A request without a token is a session's or a shell's, and the hello
// secret is its credential, as before. A request that carries a run token is a run's: the server looks the token up and holds the request to the run's kind. A local run is the tower itself, so it may do
// what a tower does (read the status, ask the link holder for a list, a board, a send, or an approved request, open and close mains of its own workspace); an ally run is a peer's message at a
// level, so it may do almost nothing (B6 widens it with the gate). Neither kind administers the GUI, the link team, the tower's tab, or the server.

export type Kind = "local" | "ally";
export interface RunInfo { id: string; workspace: string; kind: Kind }
/** A run as the tower tools see it: its kind, and for an ally run the device it serves, its label and team, the level it was claimed at, its pane, and the ask ids its messages carry. */
export interface RunWho extends RunInfo { level?: string; device?: string; deviceLabel?: string; team?: string; pane: string; asks?: string[] }
export type Verdict = { ok: true } | { ok: false; error: string };

/**
 * The link holder ops a local run may send: reading, and sending as its own tower (the server writes the sender). `request-open`, `request-run`, and `request-drop` are not here: a `link_request` goes through
 * the `run-tool` request, where the server takes it only against the boss's approval (allows.ts). Everything else (team admin, `taken`, the GUI's ops, answering confirms) is the boss's.
 */
export const LOCAL_LINK_OPS = ["list", "board-read", "send"] as const;
/** What an ally run may send the holder: its sender's device is asked to confirm a call at `forward`, and the ask is forgotten when the dialog ends another way (the server pins the device and the team). */
export const ALLY_LINK_OPS = ["confirm-request", "forget-confirm"] as const;
/** Commands that carry a run's own token as their credential (runs.ts): the token is checked there. */
const OWN_TOKEN = new Set(["run-poll", "run-taken", "run-done", "run-release", "run-file", "run-tool"]);
const LOCAL_ONLY_OWN_WORKSPACE = new Set(["open-main", "close-main"]);
const LOCAL_READS = new Set(["status"]);

const no = (error: string): Verdict => ({ ok: false, error });
const opOf = (body: unknown) => (typeof body === "object" && body !== null ? (body as { op?: unknown }).op : undefined);
export function gateRun(request: { cmd: string; workspace?: unknown; body?: unknown }, run: RunInfo): Verdict {
	const { cmd } = request;
	if (OWN_TOKEN.has(cmd)) return { ok: true };
	if (run.kind === "ally") {
		if (cmd === "link" && (ALLY_LINK_OPS as readonly unknown[]).includes(opOf(request.body))) return { ok: true };
		return no(`an ally run's token may not ask for ${cmd}`);
	}
	if (LOCAL_READS.has(cmd)) return { ok: true };
	if (LOCAL_ONLY_OWN_WORKSPACE.has(cmd)) return request.workspace === run.workspace ? { ok: true } : no(`a run token may ${cmd} only for its own workspace (${run.workspace})`);
	if (cmd === "link") {
		const op = opOf(request.body);
		return (LOCAL_LINK_OPS as readonly unknown[]).includes(op) ? { ok: true } : no(`a run token may not send the link request ${String(op)}: the team is the boss's to administer`);
	}
	return no(`a run token may not ask for ${cmd}`);
}
