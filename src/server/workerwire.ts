import { homedir } from "node:os";
import { inside } from "../link/routing.ts";
import type { Opened, OpenRequest, PeerSender as OpenerPeer } from "../opener.ts";
import { workspaces, type HerdrRun, type Pane } from "../herdr.ts";
import { subagentsOfAll } from "../netdata.ts";
import { readApps } from "../train/appsconfig.ts";
import { addRoute, type answeredAsks, markFinal, openedRoom, type Peer, readRoutes } from "./allyroute.ts";
import { createWorkerEnds } from "./workerrelay.ts";
export { workerReport } from "./workerrelay.ts";
import type { Slot } from "./record.ts";
import type { RunWho } from "./rungate.ts";
import { openWorker, type WorkerSlip } from "./workerally.ts";
import { integrationBases, readWorkers } from "./workeropen.ts";
import { readBudget } from "../capacity.ts";
import { markBook } from "./workerbook.ts";
import { sessionsDir } from "../revive.ts";

// The towers' side of the worker door (workerally.ts), kept out of towers.ts, which carries a line budget: the run's peer and asks, the workspace's checkout, the route, and the code's reply to the slip's ask.

/** The points of every worker the ally runs of these workspaces opened, by session: a worker's row counts its own (capacity.ts `joinCaps`). */
export const workerPointsOf = (slot: Slot, workspaces: readonly string[], now: number): Map<string, number> => new Map(workspaces.flatMap((ws) => readRoutes(slot, ws, now).flatMap((r) => (r.worker ? [[r.to, r.worker.points] as const] : []))));
/** Whether this box opens workers (the `tower.worker` cap): config.json has `workers` and a `capacity.budget`. */
export const workersOn = (stateDir: string) => readWorkers(stateDir) !== undefined && readBudget(stateDir) !== undefined;
/** The panes of the workers ally runs opened in a workspace: the opener counts them toward neither of the mains' limits. */
export const workerPanes = (slot: Slot, workspace: string, now: number): Set<string> => new Set(readRoutes(slot, workspace, now).flatMap((r) => (r.worker && r.pane ? [r.pane] : [])));

interface LiveLike {
	record: { id: string; workspace: string; cwd?: string };
	openAlly?: (input: OpenRequest) => Promise<Opened>;
	reach?: { read(): Promise<{ sessions: { id: string }[]; ps: { pane_id: string }[] }> };
}
interface Deps {
	slot: Slot;
	ws: string;
	who: RunWho;
	peer: Peer;
	request: OpenRequest & { slip?: WorkerSlip };
	answered: ReturnType<typeof answeredAsks>;
	l: LiveLike;
	o: { env: NodeJS.ProcessEnv; run?: HerdrRun; link?: (body: Record<string, unknown>, identity: string, served?: boolean) => Promise<unknown>; ally?: { project(team: string): string | undefined } };
	now(): number;
	log: { line(event: string, facts: Record<string, string | number | boolean>): void };
	run?: HerdrRun;
}

export async function workerDoor(d: Deps): Promise<Opened> {
	const { request, who, peer, slot, ws, l } = d;
	if (!request.slip || !request.peer || !l.openAlly) throw new Error("A worker is opened on a worker slip of the run's own device");
	const ask = request.slip.ask;
	if (ask) d.answered.add(who.id, ask); // the code answers it now, by the worker's report or by a refusal: the run's end sends no receipt for it
	const net = await l.reach?.read().catch(() => undefined), live = net && new Set(net.sessions.map((x) => x.id)), panes = net && new Set(net.ps.map((p) => p.pane_id));
	const project = who.team ? d.o.ally?.project(who.team) : undefined;
	return openWorker({
		stateDir: slot.stateDir, home: d.o.env.HOME || homedir(), now: d.now, inside,
		checkout: async () => (d.run ? (await workspaces(d.run)).find((w) => w.workspace_id === ws)?.worktree?.checkout_path : undefined) ?? l.record.cwd ?? slot.stateDir,
		...(project ? { within: project } : who.team ? { within: "" } : {}),
		reserved: (dir) => integrationBases(dir, readApps),
		room: () => openedRoom(slot, ws, peer.device, d.now(), live),
		open: l.openAlly,
		route: (opened, worker, routeAsk) => addRoute(slot, ws, { ...peer, to: opened.main, name: `worker ${worker.label}`.slice(0, 40), kind: "opened", at: d.now(), pane: opened.pane, ...(who.level ? { level: who.level } : {}), ...(routeAsk ? { ask: routeAsk } : {}), worker }, d.now(), live, panes),
		team: who.team, workspace: ws, sessionsRoot: sessionsDir(d.o.env),
		live: () => ({ routes: readRoutes(slot, ws, d.now()).flatMap((r) => (r.worker ? [{ to: r.to, ...(r.final !== undefined ? { final: r.final } : {}), path: r.worker.path }] : [])), ...(live ? { listed: live } : {}) }),
		fileOf: async (pane) => ((await l.reach?.read().catch(() => undefined))?.ps.find((p) => p.pane_id === pane) as Pane | undefined)?.agent_session?.value,
		reply: (to, text) => (d.o.link ? d.o.link({ op: "send", device: peer.device, text, reply: false, inReplyTo: to }, l.record.id, true) : Promise.reject(new Error("no link holder"))),
		log: (event, facts) => d.log.line(event, facts),
	}, request.peer as OpenerPeer, request as OpenRequest & { slip: WorkerSlip });
}

interface ServiceLike {
	record: { id: string; workspace: string };
	reach?: { read(): Promise<{ sessions: { id: string }[]; ps: { pane_id: string; agent_status?: string }[] }> };
	control?: { closeMain(query: string, opts?: { interrupt?: boolean }): Promise<unknown> };
}
/** The towers' worker sweep (workerrelay.ts `createWorkerEnds`) over their live services, the link holder, and the local run's notices. */
export function workerEndsOf(o: { slot: Slot; now(): number; log: Deps["log"]; link?: Deps["o"]["link"]; live(): ServiceLike[]; forget(workspace: string, main: string): void; notice(workspace: string, text: string, key: string): void }) {
	const of = (ws: string) => o.live().find((l) => l.record.workspace === ws);
	return createWorkerEnds({
		now: o.now, log: (event, facts) => o.log.line(event, facts), forget: o.forget, notice: o.notice,
		rows: () => o.live().flatMap((l) => readRoutes(o.slot, l.record.workspace, o.now()).filter((r) => r.kind === "opened" && r.worker).map((route) => ({ workspace: l.record.workspace, route }))),
		look: async ({ workspace, route }) => {
			const net = await of(workspace)?.reach?.read().catch(() => undefined), pane = net?.ps.find((p) => p.pane_id === route.pane);
			// A subagent of its pane that runs (a scout, a reviewer) is work too, whatever the pane shows (RV-F002).
			const kids = net && pane ? subagentsOfAll(net.ps as Pane[], o.now(), Infinity)(pane as Pane).filter((r) => !r.ended).length : 0;
			const file = (pane as Pane | undefined)?.agent_session?.value;
			return { listed: net ? net.sessions.some((s) => s.id === route.to) : true, pane: net ? pane !== undefined : undefined, working: pane?.agent_status === "working" || kids > 0, ...(file ? { file } : {}) };
		},
		close: async (ws, main, mode) => void (await of(ws)!.control!.closeMain(main, mode === "interrupt" ? { interrupt: true } : undefined)),
		send: (ws, device, text, ask) => (o.link ? o.link({ op: "send", device, text, reply: false, inReplyTo: ask }, of(ws)?.record.id ?? "", true) : Promise.reject(new Error("no link holder"))),
		stopped: (ws, main) => markFinal(o.slot, ws, main, o.now()),
		book: (main, patch, renew) => markBook(o.slot.stateDir, o.now(), main, patch, renew),
	});
}
