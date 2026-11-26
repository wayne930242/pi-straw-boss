import { Type } from "typebox";
import type { Reach } from "./reach.ts";
import type { Kit } from "./state.ts";

// `call_peer`: a member's way to a peer of its tab's net, found by sb when it is called (the boss, 2026-11-26: 「sb 包一個工具，當下找 main」; intercom stays the fallback). The one target now is `main`: the broker's record
// of the tab's main, read again at the call (`sync`), so a handover or a rotation never sends to the old session. Only a member has it in its active tools, set before each run's first model call as thread_post is
// (threadtools.ts); a main, a train, a tower, and a subagent never see it, and a call from any of them is refused.

export const PEER_TOOL = "call_peer";
export const PEER_DESCRIPTION = "Message a peer of your tab; sb finds it at the call. to: main (now, after a handover too). ask: you expect a reply (it comes by intercom).";
export const peerParameters = () => Type.Object({
	to: Type.Literal("main"),
	message: Type.String(),
	ask: Type.Optional(Type.Boolean()),
});

export interface PeerDeps {
	post: Reach["post"];
	/** The membership's refresh: reads the broker's record of the tab's main and the live sessions again. */
	sync: () => Promise<void>;
}

/** Returns the registration, made once at the join (a joined session's tools come then); the active set follows the role at every run's start. */
export function createPeerTool({ pi, s, role }: Kit, { post, sync }: PeerDeps): () => void {
	let registered = false;
	pi.on("before_agent_start", () => {
		if (!registered) return;
		const active = pi.getActiveTools(), want = role() === "member" ? [...new Set([...active, PEER_TOOL])] : active.filter((name) => name !== PEER_TOOL);
		if (want.length !== active.length) pi.setActiveTools(want);
	});
	return () => {
		if (registered) return;
		registered = true;
		pi.registerTool({
			name: PEER_TOOL, label: PEER_TOOL, description: PEER_DESCRIPTION, parameters: peerParameters(), defaultActive: false,
			execute: async (_id, { message, ask }) => {
				if (role() !== "member") throw new Error(`${PEER_TOOL} is for a tab's members; this session is ${role() ?? "in no tab's net"}. Use intercom, or call_tower for your tower.`);
				if (!message.trim()) throw new Error("The message is empty");
				await sync();
				const main = s.mainId;
				if (!main) throw new Error(`Your tab ${s.info.tab ?? ""} has no main agent. When your work grows, call boss_promote to become it (dispatching a subagent promotes you); report coordination friction with call_tower.`);
				const name = s.info.main || main;
				const result = await post(main, message, "call_peer", "tab", ask === true);
				if (result.status !== "sent") throw new Error(`The main ${name} (${main.slice(0, 8)}) did not take the message: ${[result.status, result.code, result.detail].filter(Boolean).join(" ")}`);
				return {
					content: [{ type: "text", text: `Sent to ${name}, the main of tab ${s.info.tab}. ${ask ? "Its reply comes by intercom." : "No reply is expected."}` }],
					details: { to: "main", id: main, name, status: result.status, ask: ask === true },
				};
			},
		});
	};
}
