import { Type } from "typebox";
import { integratorOf, keptIntegrators, liveIntegrator } from "./integrator.ts";
import { inside } from "./link/routing.ts";
import { candidates, handovers, lastWriter, mainsOf, selectMains, successorOf } from "./peertargets.ts";
import type { Reach } from "./reach.ts";
import type { Kit, Role } from "./state.ts";
import { checkoutProject, repoRoot } from "./train/appsconfig.ts";

// `call_peer`: a session's way to a peer of the sb net, found by sb when it is called (the boss, 2026-11-26: 「sb 包一個工具，當下找 main」, then 「agent 在同一個 sb net 找彼此，應該都可以有語法糖包好吧？intercom 直接呼叫通常是備用的」).
// Targets (peertargets.ts reads what they need): `sender`, the session that last wrote to this one; `caller`, the session that opened it (a successor's old main until it took over, else the opener's mark); `main`, the tab's
// main from the broker's record, or with `of` another main by exact name, todo item key, or tab; `integrator`, the one integrator of the checkout's project. A session whose work went on by handover is reached at its successor.
// A member, a main of any kind, and a train have it in their active tools, set before each run's first model call as thread_post is (threadtools.ts); a tower and a subagent never see it, and a call from a tower is refused.

export const PEER_TOOL = "call_peer";
const TARGETS = ["sender", "caller", "main", "integrator"] as const;
type To = (typeof TARGETS)[number];
export const PEER_DESCRIPTION = "Message an sb net peer, found at the call (successor after a handover). to: sender (last wrote you), caller (opened you), main (your tab's; of: another's name, todo item, or tab), integrator (your project's). ask: reply expected.";
export const peerParameters = () => Type.Object({
	// An enum, not a union of literals: 89 bytes fewer on every turn (pi-ai's validator checks `enum`).
	to: Type.Unsafe<To>(Type.String({ enum: TARGETS })),
	of: Type.Optional(Type.String()),
	message: Type.String(),
	ask: Type.Optional(Type.Boolean()),
});
/** The roles that send to peers: not a tower (tower_send, tower_reply), and a subagent never registers it. */
const HAS: ReadonlySet<Role | undefined> = new Set<Role | undefined>(["member", "main", "train"]);

export interface PeerDeps {
	post: Reach["post"];
	read: Reach["read"];
	openTower: Reach["openTower"];
	/** The membership's refresh: reads the broker's record of the tab's main and the live sessions again. */
	sync: () => Promise<void>;
}

/** Returns the registration, made once at the join (a joined session's tools come then); the active set follows the role at every run's start. */
export function createPeerTool({ pi, cfg, s, guiDir, me, role }: Kit, { post, read, openTower, sync }: PeerDeps): () => void {
	let registered = false;
	pi.on("before_agent_start", () => {
		if (!registered) return;
		const active = pi.getActiveTools(), want = HAS.has(role()) ? [...new Set([...active, PEER_TOOL])] : active.filter((name) => name !== PEER_TOOL);
		if (want.length !== active.length) pi.setActiveTools(want);
	});
	/** Who `to` (and `of`) names now: its id, and the words the result says it is. */
	const resolve = async (to: To, of: string | undefined): Promise<{ id: string; what: string }> => {
		const handed = handovers(guiDir), next = (id: string) => successorOf(id, handed, me());
		const after = (id: string, what: string) => ((now) => ({ id: now, what: now === id ? what : `${what} (the successor of ${id.slice(0, 8)})` }))(next(id));
		if (to === "sender") {
			const w = lastWriter(s.branch(), me());
			if (!w) throw new Error("No session has written to you in this session yet, so there is no sender. Name the main with to: main and of, or use call_tower.");
			return after(w.id, "who last wrote to you");
		}
		if (to === "caller") {
			const from = s.saved.handoverFrom;
			if (typeof from === "string" && from) return { id: from, what: "the main that handed its work to you" };
			const by = s.openedBy;
			if (!by) throw new Error(`No session opened you: you have no caller${role() === "member" ? " (a member was started by the boss)" : " (the boss opened you)"}. Use to: main with of, or call_tower.`);
			if (by.startsWith("link:")) throw new Error("You were opened for a teammate's device, which is no session here: report with call_tower; the tower relays it.");
			if (integratorOf(by)) return { id: (await openTower(undefined, false)).id, what: "the tower that opened you" };
			return after(by, "who opened you");
		}
		if (to === "integrator") {
			const project = checkoutProject(cfg.cwd());
			if (!project.ok) throw new Error(project.refusal);
			const { sessions, ps } = await read(), found = liveIntegrator(ps, sessions, project.project);
			if (found && "refusal" in found) throw new Error(found.refusal);
			if (found) return { id: found.session.id, what: `the integrator of project ${project.project}` };
			const root = repoRoot(cfg.cwd()), kept = keptIntegrators(ps, sessions, (p) => Boolean(p.cwd && (repoRoot(p.cwd) === root || inside(p.cwd, root))));
			if (kept.length !== 1) throw new Error(`Project ${project.project} (${project.from}) has ${kept.length ? `${kept.length} integrators: ${kept.map((k) => `${k.session.name ?? k.session.id} (${k.session.id.slice(0, 8)})`).join("; ")}` : "no live integrator"}. Name one with to: main and of, or use call_tower.`);
			return { id: kept[0]!.session.id, what: `the integrator of project ${project.project}` };
		}
		if (of === undefined) {
			if (role() === "main") throw new Error("You are your tab's main: name another main with of (its name, a todo item key, or its tab).");
			await sync();
			if (s.mainId) return { id: s.mainId, what: `the main of tab ${s.info.tab}` };
			if (role() === "train") throw new Error("A train's tab has no main: name one with of, or use call_tower.");
			throw new Error(`Your tab ${s.info.tab ?? ""} has no main agent. When your work grows, call boss_promote to become it (dispatching a subagent promotes you); report coordination friction with call_tower.`);
		}
		const { sessions, ps } = await read(), mains = mainsOf(sessions, ps), hit = selectMains(of, mains, handed, me());
		if (hit.length !== 1) throw new Error(`${hit.length ? `${hit.length} mains match` : "No live main matches"} "${of}" (exact name, todo item key t_… or <session8>#<id>, tab id or label). ${hit.length ? "Matches" : "Mains"}: ${candidates(hit.length ? hit : mains)}.`);
		return { id: hit[0]!.id, what: `the main of tab ${hit[0]!.tab.label}` };
	};
	return () => {
		if (registered) return;
		registered = true;
		pi.registerTool({
			name: PEER_TOOL, label: PEER_TOOL, description: PEER_DESCRIPTION, parameters: peerParameters(), defaultActive: false,
			execute: async (_id, { to, of, message, ask }) => {
				if (!HAS.has(role())) throw new Error(`${PEER_TOOL} is for the sessions of a tab's net; this session is ${role() ?? "in no tab's net"}. ${role() === "tower" ? "Use tower_send or tower_reply." : "Use intercom."}`);
				if (!(TARGETS as readonly string[]).includes(to)) throw new Error(`to is ${TARGETS.join(", ")}, not ${JSON.stringify(to)}`);
				if (!message.trim()) throw new Error("The message is empty");
				if (of !== undefined && to !== "main") throw new Error("of names a main: use it with to: main");
				const target = await resolve(to, of?.trim() || undefined);
				if (target.id === me()) throw new Error(`${target.what} is you: nothing to send`);
				const name = (await read()).sessions.find((x) => x.id === target.id)?.name ?? target.id;
				const result = await post(target.id, message, "call_peer", to === "main" && of === undefined ? "tab" : to, ask === true);
				if (result.status !== "sent") throw new Error(`${name} (${target.id.slice(0, 8)}), ${target.what}, did not take the message: ${[result.status, result.code, result.detail].filter(Boolean).join(" ")}`);
				return {
					content: [{ type: "text", text: `Sent to ${name}, ${target.what}. ${ask ? "Its reply comes by intercom." : "No reply is expected."}` }],
					details: { to, id: target.id, name, status: result.status, ask: ask === true },
				};
			},
		});
	};
}
