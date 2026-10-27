import type { Briefing } from "./briefing.ts";
import type { Election } from "./election.ts";
import type { Guard } from "./guard.ts";
import { place, waitFor, workspaces } from "./herdr.ts";
import type { Presence } from "./presence.ts";
import { nameOf, type Reach, STOPPED } from "./reach.ts";
import type { Roles } from "./roles.ts";
import { type Channel, ENTRY, type Kit, REGISTER } from "./state.ts";

const NAMESPACE = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
export const CONNECT_MS = 15_000;
const CLAIM_MS = 5000;
type Event = { type: string; fromSessionId?: string; owner?: { sessionId: string }; payload?: { type?: string; force?: boolean } };
/** What membership calls on the other modules; `register` adds the tools a joined session has. */
interface Parts { presence: Presence; election: Election; guard: Guard; briefing: Briefing; roles: Roles; openTower: Reach["openTower"]; register(): void; control(): { register(): void } }

/** Joining the tab's net: its intercom channel, the events that change the session's role, and becoming the tab's main. */
export function createMembership({ pi, cfg, s, me, tell }: Kit, { presence, election, guard, briefing, roles, openTower, register, control }: Parts) {
	const { run, sleep, autoTower } = cfg;
	let joining: Promise<void> | undefined;
	// A join that failed after registering retries on the tab the session is in now: its channel when it has registered there already, else a new
	// one. Intercom has no unregister, so a tab left behind stays registered; see `onEvent` for what that channel still does.
	const channels = new Map<string, Channel>();
	const use = (channel: Channel) => ((s.pinned = channel === s.c ? s.pinned : undefined), (s.c = channel)); // what was pinned on another tab's channel is not this one's
	const connect = (eligible: boolean) => {
		const namespace = `straw-boss/tab/${Buffer.from(s.at.tabId).toString("hex")}`;
		if (channels.has(namespace)) return void use(channels.get(namespace)!);
		if (!NAMESPACE.test(namespace)) throw new Error(`Tab id ${s.at.tabId} is too long for an intercom namespace (limit 24 characters)`);
		let mine: Channel | undefined;
		pi.events.emit(REGISTER, { namespace, ownerEligible: eligible, onReady: (channel: Channel) => { mine = channel; channels.set(namespace, channel); use(channel); }, onEvent: (event: Event) => mine && onEvent(mine, event) });
		if (!mine) throw new Error("pi-intercom is not loaded (Straw Boss needs pi-intercom >= 0.17.1)");
	};
	// A tab this session left stays registered, and if the session owns that channel it still decides that tab's claims (or its members could
	// never promote); nothing else that channel says concerns the session's role.
	const onEvent = (channel: Channel, event: Event) => {
		if (event.type === "message" && event.payload?.type === "claim" && event.fromSessionId) {
			const [from, force] = [event.fromSessionId, Boolean(event.payload.force)];
			s.queue = s.queue.then(() => election.claim(channel, from, force));
		}
		if (channel !== s.c) return;
		// Ownership moved away: what this session pinned as owner is no longer its to defend.
		if (event.type === "owner" && event.owner?.sessionId !== me()) s.pinned = undefined;
		// A join that failed at start (intercom not connected yet, no owner yet) is retried when the channel changes.
		if (!s.joined && !s.barred && !s.isTower && ["connection", "owner"].includes(event.type)) void joinNet().catch(() => {});
		if (["connection", "owner", "state", "session_left"].includes(event.type)) void sync();
		// The tab's owner or main may have changed hands (a main that left): the new owner checks the tab under its tower.
		if (s.joined && ["owner", "session_left"].includes(event.type)) guard.check();
		if (["presence_update", "session_joined", "session_left"].includes(event.type)) s.dashboard?.poke();
	};
	// The opener a restored main had becomes its own once it is the main, in time or when the owner confirms late: the same steps as an opened main's claim.
	const adoptOpener = async () => {
		const opener = s.restoredOpener;
		s.restoredOpener = undefined;
		if (!opener || s.openedBy) return;
		s.openedBy = opener;
		pi.appendEntry(ENTRY, { openedBy: opener, openedPane: s.at.paneId }); // a later /reload in this pane restores it as it does for an opened main
		control().register();
		await presence.publish();
	};
	const refresh = async () => {
		if (!s.joined) return;
		try {
			const snap = s.c.snapshot();
			if (snap.owner?.sessionId !== me()) s.pinned = undefined;
			const sessions = await s.c.listSessions();
			// A main that has left leaves the tab without one until a member promotes.
			const recorded = (snap.state?.payload as { main?: string } | undefined)?.main;
			if (s.pinned === recorded) s.pinned = undefined; // the broker has echoed it
			s.mainId = sessions.find((x) => x.id === (s.pinned ?? recorded))?.id;
			const ws = (await workspaces(run)).find((w) => w.workspace_id === s.at.workspaceId);
			const tab = sessions.find((x) => x.id === me())?.herdrLocation?.tab?.label ?? s.at.tabId;
			s.info = { tab, workspace: ws?.label ?? s.at.workspaceId, main: nameOf(sessions.find((x) => x.id === s.mainId)), tower: nameOf(sessions.find((x) => x.id === ws?.tokens?.tower)) };
			const wasMain = s.isMain;
			s.isMain = s.mainId === me();
			if (s.isMain !== wasMain) (tell(`This session is ${s.isMain ? "now" : "no longer"} the main agent of ${s.info.tab}`), briefing.rebrief());
			await presence.publish(sessions);
			if (s.isMain && !wasMain) {
				roles.remember("main");
				if (s.restored) await adoptOpener(); // the late confirmation of a claim that timed out
				// The workspace's first main opens the tower at once; later mains find it open. A main a Herdr restore gave back finds its tower coming back too.
				if (s.restored) s.restored = false;
				else if (autoTower) void openTower(undefined, true).catch((error: Error) => error.message !== STOPPED && tell(`Straw Boss: could not open the tower: ${error.message}`, "warning"));
			}
		} catch (error) {
			tell(`Straw Boss: ${(error as Error).message}`, "warning");
		}
	};
	const sync = () => (s.queue = s.queue.then(refresh));
	// A session that has just started connects to the broker a moment after session_start.
	const connected = async (channel = s.c) => {
		if (await waitFor(sleep, () => channel.snapshot().connected && channel.snapshot().supported, CONNECT_MS)) return;
		throw new Error(channel.snapshot().connected ? "The intercom broker lacks extension-bus-v1" : "pi-intercom is not connected");
	};
	// Every joinable session joins at start as a member (owner-eligible, so the tab channel always has an owner). One join at a time.
	const joinNet = () =>
		(joining ??= (async () => {
			if (s.joined) return;
			if (s.barred) throw new Error(s.barred);
			s.at = await place(run);
			connect(true);
			await connected();
			if (!(await waitFor(sleep, () => s.c.snapshot().owner, CLAIM_MS))) throw new Error("No intercom owner was elected for this tab");
			s.joined = true;
			register();
			presence.keepFresh();
			guard.keep();
			await sync();
		})().catch((error) => {
			joining = undefined;
			throw error;
		}));
	// Becoming the tab's main agent. Without `force` a tab that already has a live main refuses; /boss forces.
	const promote = async (force: boolean): Promise<{ promoted: boolean; text: string }> => {
		await joinNet();
		await sync();
		if (s.isMain) return { promoted: true, text: `You are already the main agent of tab ${s.info.tab}.` };
		const refused = () => ({ promoted: false, text: `Tab ${s.info.tab} already has a main agent, ${s.info.main}. Stay a member: you may dispatch your own subagents, but tell ${s.info.main} through intercom first what you will do and which resources you will use.` });
		if (!force && s.mainId) return refused();
		if (s.c.snapshot().owner?.sessionId === me()) await (s.queue = s.queue.then(() => election.claim(s.c, me(), force)));
		else s.c.publish({ type: "claim", force }, { audience: "owner" });
		if (!(await waitFor(sleep, () => s.isMain, CLAIM_MS))) {
			await sync();
			if (s.isMain) return { promoted: true, text: `You are now the main agent of tab ${s.info.tab}.` };
			if (!force && s.mainId && s.mainId !== me()) return refused();
			throw new Error("The owner did not confirm the promotion within 5 s");
		}
		return { promoted: true, text: `You are now the main agent of tab ${s.info.tab}.` };
	};
	return { connect, connected, joinNet, promote, adoptOpener };
}
export type Membership = ReturnType<typeof createMembership>;
