import type { Allows } from "./allows.ts";
import type { Kids } from "./runkids.ts";
import type { RunWho } from "./rungate.ts";

// A headless run's approvals (review REV-F002; docs/specs/2026-11-23-f-entry.md §2.7): a run with no pane has no bridge, so its link_request and an ally run's gated call are the server's own dialogs, shown in the
// viewers and on this computer's page. The boss's yes (or the sender's device's forward yes) is one Allow bound to the run, the call id and what was approved (allows.ts `noteRun`); a no records nothing.
export function runApprover(o: { runOf(token: unknown): RunWho | undefined; kids(): Kids | undefined; live(workspace: string): { stopped: boolean; record: { label: string }; requests: Map<string, string[]> } | undefined; allows(): Allows | undefined }) {
	return async (request: Record<string, unknown>): Promise<{ approved: boolean }> => {
		const who = o.runOf(request.token), kids = o.kids();
		if (!who) throw new Error("unknown_token");
		if (!who.headless || !kids) throw new Error("only a headless run asks the server for its approvals; a run in a pane shows its own");
		const toolCallId = typeof request.toolCallId === "string" && /^[\w.:-]{1,128}$/.test(request.toolCallId) ? request.toolCallId : undefined;
		if (!toolCallId) throw new Error("an approval is for one tool call: its id");
		const id = `approve-${toolCallId}`;
		if (request.drop === true) return (kids.withdraw(who.id, id), { approved: false });
		if (kids.dialogs(who.workspace).filter((d) => d.run === who.id && d.approval).length >= 4) throw new Error("this run already waits on four approvals");
		const l = o.live(who.workspace);
		if (!l || l.stopped) throw new Error(`The sb server stands in for no tower of workspace ${who.workspace}`);
		if (request.kind === "request" && who.kind === "local") {
			const lines = l.requests.get(String(request.id));
			if (!lines) throw new Error("This run opened no such request");
			const body = [...lines, `Asked by session: tower run of ${l.record.label} (${who.id.slice(0, 8)})`].join("\n");
			if (body.length > 12_000) throw new Error(`a link request whose description is ${body.length} characters long cannot be confirmed (the most is 12000); it is refused`);
			const approved = await kids.confirm({ run: who.id, workspace: who.workspace, id, title: `Link request from the tower run of ${l.record.label}`, message: body });
			if (approved) o.allows()?.noteRun({ run: who.id, toolCallId, lines });
			return { approved };
		}
		if (request.kind === "gate" && who.kind === "ally") {
			const tool = typeof request.tool === "string" && /^[\w-]{1,64}$/.test(request.tool) ? request.tool : undefined, args = request.args;
			if (!tool || typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("a gated call's approval names its tool and its arguments");
			const shown = JSON.stringify(args, null, 2) ?? "{}";
			if (shown.length > 12_000) throw new Error(`a remote request whose arguments are ${shown.length} characters long cannot be confirmed (the most is 12000); it is refused`);
			const approved = await kids.confirm({ run: who.id, workspace: who.workspace, id, title: `Remote request from ${who.deviceLabel ?? "a teammate's device"} (${who.deviceShort ?? "?"}, trust ${who.level ?? "reply"}): ${tool}`, message: shown });
			if (approved) o.allows()?.noteRun({ run: who.id, toolCallId, tool, args });
			return { approved };
		}
		throw new Error("a local run asks approval for a link_request, an ally run for a gated call");
	};
}
