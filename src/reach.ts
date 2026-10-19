import { randomUUID } from "node:crypto";
import { headOf, isSub, type Pane, panes, parentOf, type Session, towerModel, workspaces, type Workspace } from "./herdr.ts";
import type { Kit, Scope, SendResult } from "./state.ts";
import { ensureTower } from "./towertab.ts";

const OUTBOX = "intercom:outbox-request";
const OUTBOX_RESULT = "intercom:outbox-result";
const SEND_MS = 30_000;

/** Live sessions whose pane carries an `sb_role` token: the sessions that joined the net, and towers. */
export function netMembers(sessions: Session[], ps: Pane[]) {
	return sessions.flatMap((s) => {
		const { workspace, tab, paneId } = s.herdrLocation ?? {};
		const role = ps.find((p) => p.pane_id === paneId)?.tokens?.sb_role;
		return workspace && tab && role ? [{ s, role, tab, workspace }] : [];
	});
}
type Member = ReturnType<typeof netMembers>[number];
export const nameOf = (s?: Session) => (s ? (s.name ?? s.id) : "");

/** How a session reaches the rest of the net: one message, a broadcast, the coordinators' status, and the tower of a workspace. */
export function createReach({ pi, cfg, s, guiDir, me, role, tell }: Kit) {
	const { run, api, sleep } = cfg;
	const nonce = randomUUID().slice(0, 8);
	let requests = 0;
	const send = (to: string, message: string) =>
		new Promise<SendResult>((resolve) => {
			// pi-intercom keeps a message id per sender session and refuses it again with other content, and a restarted pi keeps its session id: the id carries this process's own nonce.
			const requestId = `straw-boss-${me()}-${nonce}-${++requests}`;
			const done = (result: SendResult) => {
				off();
				clearTimeout(timeout);
				resolve(result);
			};
			const off = pi.events.on(OUTBOX_RESULT, (data) => (data as SendResult).requestId === requestId && done(data as SendResult));
			const timeout = setTimeout(() => done({ status: "failed", detail: `no result within ${SEND_MS / 1000} s` }), SEND_MS);
			pi.events.emit(OUTBOX, { version: 1, requestId, extensionId: "pi-straw-boss", extensionName: "Pi Straw Boss", to, message });
		});
	/** The tower of this workspace, or of another by id or label. A missing tower is opened only in this workspace: by /boss tower, by a main, or by the guard's rule. */
	const openTower = async (query?: string, create = s.isMain) => {
		const all = await workspaces(run);
		const found = all.filter((w) => (query ? w.workspace_id === query || w.label === query : w.workspace_id === s.at.workspaceId));
		if (found.length !== 1) {
			throw new Error(`${found.length ? "Several workspaces match" : "No workspace matches"} "${query}". Workspaces: ${all.map((w) => `${w.workspace_id} (${w.label})`).join(", ")}`);
		}
		// A sub workspace never has a tower: its parent workspace's tower serves it.
		const asked = found[0]!;
		const target = isSub(asked) ? parentOf(all, asked) : asked;
		if (!target) throw new Error(`${asked.label} is a sub workspace with no open parent workspace, so it has no tower; open the parent workspace first`);
		if (s.isTower && target.workspace_id === s.at.workspaceId) throw new Error("This session is the tower of that workspace");
		const live = async (id: string) => (await s.c.listSessions()).some((x) => x.id === id);
		const held = target.tokens?.tower;
		if (!create || target.workspace_id !== s.at.workspaceId) {
			if (held && (await live(held))) return { target, routed: target !== asked ? asked : undefined, id: held, opened: false };
			throw new Error(`${target.label} has no tower yet: it opens when a member there promotes itself to main`);
		}
		const moveFirst = (tabId: string) => api("tab.move", { tab_id: tabId, insert_index: 0 }).catch((error: Error) => tell(`Straw Boss: could not move the tower tab first: ${error.message}`, "warning"));
		return { target, routed: target !== asked ? asked : undefined, ...(await ensureTower({ run, sleep, live, moveFirst, model: towerModel(guiDir) }, target, process.cwd())) };
	};
	const status = async () => {
		const sessions = await s.c.listSessions();
		const [ps, all] = [await panes(run), await workspaces(run)];
		const mine = all.find((w) => w.workspace_id === s.at.workspaceId);
		const towerOf = (w?: Workspace) => {
			const x = sessions.find((y) => y.id === w?.tokens?.tower);
			return x && w && { workspace: w.label, id: x.id, name: nameOf(x), head: w === headOf(all) };
		};
		const own = netMembers(sessions, ps).filter((m) => m.workspace.id === s.at.workspaceId && m.role !== "tower");
		const tabs = Object.values(Object.groupBy(own, (m) => m.tab.id)).map((group = []) => ({
			id: group[0]?.tab.id,
			label: group[0]?.tab.label,
			main: group.find((m) => m.role === "main")?.s.id ?? null,
			sessions: group.length,
		}));
		return {
			me: { id: me(), role: role() },
			workspace: { id: s.at.workspaceId, label: mine?.label },
			head: headOf(all)?.workspace_id,
			tower: towerOf(mine) ?? null,
			tabs,
			towers: all.filter((w) => w !== mine).flatMap((w) => towerOf(w) ?? []),
		};
	};
	const broadcast = async (message: string, scope: Scope) => {
		const others = (await s.c.listSessions()).filter((x) => x.id !== me());
		const inScope = (m: Member) => ({ tab: m.tab.id === s.at.tabId, workspace: m.workspace.id === s.at.workspaceId, towers: m.role === "tower" })[scope as Exclude<Scope, "all">];
		// tab, workspace, and towers reach the net only; all reaches every other pi session on the machine.
		const targets = scope === "all" ? others : netMembers(others, await panes(run)).filter(inScope).map((m) => m.s);
		const results = await Promise.all(targets.map(async (x) => ({ id: x.id, name: nameOf(x), ...(await send(x.id, message)) })));
		const summary = results.map((r) => `${r.name}: ${r.status}${r.code ? ` (${r.code})` : ""}`).join("\n") || "no recipients";
		if (results.some((r) => r.status !== "sent")) throw new Error(`Not every recipient received it:\n${summary}`);
		return { text: `Broadcast to ${results.length} session(s):\n${summary}`, details: { scope, results } };
	};
	return { send, openTower, status, broadcast };
}
export type Reach = ReturnType<typeof createReach>;
