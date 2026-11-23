import { sessionMark } from "./netdata.ts";
import type { Kind, Stamp, Why } from "./header.ts";
import { headTowerOf, type Pane, type Session, type Workspace } from "./herdr.ts";
import type { SendResult } from "./state.ts";

// The head tower's two sends and its reading in the net (docs/specs/2026-11-04-head-tower.md, Forwarding, and the answers): reach.ts owns the net and the header; this holds what is the head's alone.

type Sent = SendResult & { name: string };
interface Net { sessions: Session[]; all: Workspace[] }
interface Seams {
	read(): Promise<Net>;
	deliver(targets: Session[], message: string, kind: Kind, scope: string, reply: boolean, net: Net, origin?: string, why?: Why, extra?: Pick<Stamp, "ask" | "relay" | "inReplyTo">): Promise<Sent[]>;
}

/** The head tower's identity: the value of its workspace's `sb_head` token. A workspace or pane that merely says `head` makes no session the head. */
export const headIdOf = (all: Workspace[]) => headTowerOf(all)?.tokens?.sb_head;
/** The head tower as `tower_list` and `board_read` (section towers) show it: its identity and what it is doing; null until its workspace exists. */
export const headInfo = (sessions: Session[], ps: Pane[], all: Workspace[]) => {
	const id = headIdOf(all), x = sessions.find((y) => y.id === id);
	return id ? { id, state: x ? sessionMark(x, ps.find((p) => p.pane_id === x.herdrLocation?.paneId)) : "unknown" } : null;
};

export function createHeadReach({ read, deliver }: Seams) {
	return {
		/** The head tower's forward to one workspace tower (headtools.ts): the message under the head's header with its ask and, when the boss's own turn made it, the relay. */
		async forward(towerId: string, message: string, extra: { ask: string; relay?: string }, reply = true): Promise<Sent> {
			const net = await read(), session = net.sessions.find((x) => x.id === towerId);
			if (!session) throw new Error("That tower is not registered with pi-intercom yet; try again in a moment");
			const [result] = await deliver([session], message, "tower_send", "tower", reply, net, undefined, undefined, extra);
			return result!;
		},
		/** A workspace tower's answer to one of the head's asks: it goes to the head identity under the tower's header with `in-reply-to`. */
		async answerHead(message: string, inReplyTo: string): Promise<Sent> {
			const net = await read(), id = headIdOf(net.all), session = net.sessions.find((x) => x.id === id);
			if (!session) throw new Error("The head tower is not open, so nothing can be answered to it");
			const [result] = await deliver([session], message, "tower_send", "tower", false, net, undefined, undefined, { inReplyTo });
			return result!;
		},
	};
}
