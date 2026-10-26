import { randomUUID } from "node:crypto";
import { sessionMark } from "./dashboard.ts";
import { type Kind, type Party, stamp } from "./header.ts";
import { headOf, isSub, type Pane, panes, parentOf, type Session, towerModel, workspaces, type Workspace } from "./herdr.ts";
import type { Kit, Scope, SendResult } from "./state.ts";
import { ensureTower } from "./towertab.ts";
import { trustDir } from "./trust/files.ts";

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
		return { target, routed: target !== asked ? asked : undefined, ...(await ensureTower({ run, sleep, live, moveFirst, model: towerModel(guiDir), trustDir: trustDir(guiDir) }, target, process.cwd())) };
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
	/** One reading of the net: the live sessions, every pane, every workspace. */
	const read = async () => {
		const [sessions, ps, all] = await Promise.all([s.c.listSessions(), panes(run), workspaces(run)]);
		return { sessions, ps, all };
	};
	type Net = Awaited<ReturnType<typeof read>>;
	const ROLES = new Set(["tower", "main", "member"]);
	/** A session as a header names it: its role is the one its pane's token publishes, `session` for a pi that did not join. */
	const partyOf = (x: Session, net: Net): Party => {
		const token = net.ps.find((p) => p.pane_id === x.herdrLocation?.paneId)?.tokens?.sb_role ?? "";
		const role = ROLES.has(token) ? (token as Party["role"]) : "session";
		const workspace = x.herdrLocation?.workspace;
		return { name: nameOf(x) || x.id, id: x.id, role, ...(role === "tower" && workspace?.id === headOf(net.all)?.workspace_id ? { head: true } : {}), ...(workspace?.label ? { workspace: workspace.label } : {}) };
	};
	const selfParty = (net: Net): Party => {
		const mine = net.sessions.find((x) => x.id === me()), workspace = net.all.find((w) => w.workspace_id === s.at.workspaceId);
		return { name: nameOf(mine) || s.ownName || me(), id: me(), role: role() ?? "session", ...(s.isTower && workspace && workspace === headOf(net.all) ? { head: true } : {}), ...(workspace ? { workspace: workspace.label } : {}) };
	};
	/** The message under its header, once for the whole audience: every recipient reads the same line, with the others named in it. */
	const deliver = async (targets: Session[], message: string, kind: Kind, scope: string, reply: boolean, net: Net) => {
		const line = stamp({ from: selfParty(net), kind, scope, to: targets.map((x) => partyOf(x, net)), reply, ...(s.remoteOrigin ? { origin: s.remoteOrigin } : {}) }, message);
		return Promise.all(targets.map(async (x) => ({ id: x.id, name: nameOf(x), ...(await send(x.id, line)) })));
	};
	/** One session by id, with a header. The result is intercom's. */
	const post = async (to: string, message: string, kind: Kind, scope: string, reply: boolean): Promise<SendResult> => {
		const net = await read();
		const [result] = await deliver([net.sessions.find((x) => x.id === to) ?? { id: to }], message, kind, scope, reply, net);
		return result!;
	};
	const callTower = async (message: string, workspace: string | undefined, reply = true) => {
		const tower = await openTower(workspace);
		const result = await post(tower.id, message, "call_tower", "tower", reply);
		if (result.status !== "sent") throw new Error(`The tower of ${tower.target.label} did not take the message: ${result.status} ${result.code ?? ""} ${result.detail ?? ""}`.trim());
		const via = tower.routed ? ` (${tower.routed.label} is a sub workspace)` : "";
		const text = `Sent to the tower of ${tower.target.label}${via}${tower.opened ? " (opened it)" : ""}. ${reply ? "It replies through intercom." : "It is told no reply is expected."}`;
		return { text, details: { workspace: tower.target.workspace_id, towerId: tower.id, opened: tower.opened, status: result.status } };
	};

	/** Who a message for a workspace's tower reaches: its live tower; in a workspace without one, its mains, else its members (a tower only coordinates, so a workspace without one still has someone to hear). */
	const stationsOf = (net: Net) => {
		const members = netMembers(net.sessions, net.ps), head = headOf(net.all);
		return net.all.filter((w) => !isSub(w)).map((workspace) => {
			const tower = net.sessions.find((x) => x.id === workspace.tokens?.tower);
			const here = members.filter((m) => m.workspace.id === workspace.workspace_id && m.role !== "tower");
			const [mains, plain] = [here.filter((m) => m.role === "main").map((m) => m.s), here.filter((m) => m.role === "member").map((m) => m.s)];
			const [via, sessions]: ["tower" | "main" | "member" | "none", Session[]] = tower ? ["tower", [tower]] : mains.length ? ["main", mains] : plain.length ? ["member", plain] : ["none", []];
			return { workspace, head: workspace === head, self: workspace.workspace_id === s.at.workspaceId, via, sessions, members: here };
		});
	};
	type Station = ReturnType<typeof stationsOf>[number];
	/** The stations a message from this session can reach: not itself, and not the fallback sessions of its own workspace (its siblings), which are no tower. */
	const reachable = (net: Net) => stationsOf(net).map((st): Station => ({ ...st, sessions: st.sessions.filter((x) => x.id !== me()) })).filter((st) => st.sessions.length && !(st.self && st.via !== "tower"));
	const noTower = (st: Station) => (st.via === "tower" ? undefined : `no tower in ${st.workspace.label}: ${st.via}`);
	const report = (results: Awaited<ReturnType<typeof deliver>>, notes: Map<string, string>, scope: string) => {
		const summary = results.map((r) => `${r.name}: ${r.status}${r.code ? ` (${r.code})` : ""}${notes.has(r.id) ? ` [${notes.get(r.id)}]` : ""}`).join("\n") || "no recipients";
		if (results.some((r) => r.status !== "sent")) throw new Error(`Not every recipient received it:\n${summary}`);
		return { text: `Broadcast to ${results.length} session(s):\n${summary}`, details: { scope, results } };
	};
	const broadcast = async (message: string, scope: Scope, reply = false) => {
		const net = await read(), others = net.sessions.filter((x) => x.id !== me());
		const notes = new Map<string, string>();
		let targets: Session[];
		if (scope === "towers") {
			targets = reachable(net).flatMap((st) => st.sessions.map((x) => (noTower(st) && notes.set(x.id, noTower(st)!), x)));
		} else {
			const inScope = (m: Member) => ({ tab: m.tab.id === s.at.tabId, workspace: m.workspace.id === s.at.workspaceId })[scope as "tab" | "workspace"];
			// tab and workspace reach the net only; all reaches every other pi session on the machine.
			targets = scope === "all" ? others : netMembers(others, net.ps).filter(inScope).map((m) => m.s);
		}
		return report(await deliver(targets, message, "broadcast", scope, reply, net), notes, scope);
	};

	/** Every workspace's tower for a tower to choose from: who hears a message for it, what that session is doing, and what each tab is working on. */
	const towerList = async () => {
		const net = await read(), mark = (x: Session) => ({ id: x.id, name: nameOf(x), state: sessionMark(x, net.ps.find((p) => p.pane_id === x.herdrLocation?.paneId)) });
		const mine = net.all.find((w) => w.workspace_id === s.at.workspaceId);
		const towers = stationsOf(net).map((st) => {
			const tabs = Object.values(Object.groupBy(st.members, (m) => m.tab.id)).map((group = []) => ({ label: group[0]!.tab.label, main: nameOf(group.find((m) => m.role === "main")?.s) || null, members: group.filter((m) => m.role === "member").map((m) => nameOf(m.s)) }));
			return { workspace: { id: st.workspace.workspace_id, label: st.workspace.label }, head: st.head, self: st.self, reach: st.via, sessions: st.sessions.map(mark), tabs };
		});
		const result = { me: { id: me(), role: role(), workspace: { id: s.at.workspaceId, label: mine?.label } }, head: headOf(net.all)?.workspace_id, towers };
		return { text: JSON.stringify(result, null, 2), details: result };
	};
	/** One tower by workspace id or label (a sub workspace goes to its parent), or every other tower; a workspace without a tower is reached through its mains, else its members. */
	const towerSend = async (message: string, workspace: string | undefined, reply = false) => {
		const net = await read(), stations = reachable(net), notes = new Map<string, string>();
		let chosen = stations;
		if (workspace !== undefined) {
			const found = net.all.filter((w) => w.workspace_id === workspace || w.label === workspace);
			if (found.length !== 1) throw new Error(`${found.length ? "Several workspaces match" : "No workspace matches"} "${workspace}". Workspaces: ${net.all.map((w) => `${w.workspace_id} (${w.label})`).join(", ")}`);
			const asked = found[0]!, target = isSub(asked) ? parentOf(net.all, asked) : asked;
			if (!target) throw new Error(`${asked.label} is a sub workspace with no open parent workspace, so it has no tower`);
			chosen = stations.filter((st) => st.workspace === target);
			if (!chosen.length) {
				const st = stationsOf(net).find((x) => x.workspace === target);
				throw new Error(st?.self && st.via === "tower" ? "This session is the tower of that workspace" : `${target.label} has no tower and no joined session to hear a message`);
			}
		}
		const targets = chosen.flatMap((st) => st.sessions.map((x) => (noTower(st) && notes.set(x.id, noTower(st)!), x)));
		return report(await deliver(targets, message, "tower_send", workspace === undefined ? "towers" : "tower", reply, net), notes, workspace === undefined ? "towers" : "tower");
	};
	return { send, post, callTower, openTower, status, broadcast, towerList, towerSend };
}
export type Reach = ReturnType<typeof createReach>;
