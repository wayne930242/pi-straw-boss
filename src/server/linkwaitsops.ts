import type { HerdrRun, Session } from "../herdr.ts";
import { panes } from "../herdr.ts";
import type { HolderOptions } from "../link/holder.ts";
import type { LinkService } from "../link/service.ts";
import { restrictLabel } from "../link/text.ts";
import { localeOf } from "../towerprompt/messages.ts";
import { raiserRefusal } from "./allywait.ts";
import type { Asks } from "./asks.ts";
import { createLinkWaits, isOpen, type LinkWaits, readWaits } from "./linkwaits.ts";
import type { Slot } from "./record.ts";
import type { Towers } from "./towers.ts";
import { sendStanding } from "./standingsend.ts";
import { listServices } from "./towerstore.ts";
import { nameOf } from "../reach.ts";

// The wait router wired into the sb server (docs/specs/2026-11-21-box-mac-waits.md): its seams to the link holder (sends as a workspace's tower identity, a device's caps), to the tower service (a line from a tower identity, a card), and
// the holder ops sessions and runs ask it through (`device-resolve`, `wait-act`, `wait-cancel`, `waits-read`). Kept out of main.ts, which carries a line budget.

const WAIT_TICK_MS = 60_000;
type Answer = { ok: boolean; error?: string; [key: string]: unknown };

export interface StartWaits {
	slot: Slot;
	env: NodeJS.ProcessEnv;
	now(): number;
	log(event: string, facts: Record<string, string | number | boolean>): void;
	run: HerdrRun;
	sessions(): Promise<Session[]>;
	towers(): Towers | undefined;
	link(): LinkService | undefined;
	stops: (() => void)[];
	/** Auto mode's switch: a card is parked while it is on. */
	autoOn?(): boolean;
	/** The asks the towers made for their mains (asks.ts): a box's notice about one goes to its main. */
	asks?: { find(ask: string): { for: string; workspace: string; device: string } | undefined } & Partial<Pick<Asks, "open">>;
	/** A test's clock for the sweep; none starts the minute timer. */
	tickMs?: number | false;
}
export interface WaitsHub {
	router: LinkWaits;
	/** What the holder hands the router (HolderOptions `waits`). */
	holder: NonNullable<HolderOptions["waits"]>;
	/** The holder ops of a session or a run. */
	op(body: Record<string, unknown>, from: string): Promise<Answer>;
}

export function startLinkWaits(o: StartWaits): WaitsHub {
	const net = async () => {
		const [sessions, ps] = await Promise.all([o.sessions(), panes(o.run)]);
		return { sessions, ps };
	};
	const router = createLinkWaits({
		slot: o.slot, now: o.now, log: o.log, locale: () => localeOf(o.env, o.slot.stateDir), net, ...(o.autoOn ? { autoOn: o.autoOn } : {}),
		post: (ws, to, text, kind, extra) => o.towers()?.post(ws, to, text, kind, extra) ?? Promise.resolve(false),
		send: async (ws, req) => {
			const link = o.link(), identity = o.towers()?.identityOf(ws);
			if (!link || !identity) return { ok: false, error: "no tower or link holder runs for this workspace" };
			return link.request({ op: "send", device: req.device, text: req.text, reply: false, ...(req.wait ? { wait: req.wait } : {}), ...(req.inReplyTo ? { inReplyTo: req.inReplyTo } : {}) }, identity, true);
		},
		caps: (team, device) => o.link()?.holder?.capsFor(team, device) ?? [],
		deviceId: () => o.link()?.holder?.deviceId,
		selfLabel: () => restrictLabel(o.link()?.holder?.deviceLabel ?? "this computer"),
		workspaces: () => listServices(o.slot).map((r) => r.workspace),
		// The boss's delegate (D14): link config's (the policy file's on an unattended device), the level this device gives it, its roster entry, and the tower's notice for its answer.
		delegate: () => o.link()?.config().delegate, level: (device) => o.link()?.levelOf(device) ?? "reply",
		member: (device) => ((r) => (r?.ok ? { team: r.team, label: r.label, short: r.short } : undefined))(o.link()?.holder?.resolveTeammate(device)),
		notify: (ws, text, key) => o.towers()?.runs.notice(ws, text, key) ?? false,
	});
	if (o.tickMs !== false) {
		const timer = setInterval(() => void router.tick().catch((e: Error) => o.log("link-wait-tick-failed", { error: e.message.slice(0, 160) })), o.tickMs ?? WAIT_TICK_MS);
		timer.unref?.();
		o.stops.push(() => clearInterval(timer));
	}
	const served = (ws: string | undefined) => (ws !== undefined && o.towers()?.identityOf(ws) ? ws : undefined);
	/** The workspace a session or a tower identity is in, from the broker and Herdr. */
	const wsOf = async (from: string) => {
		const n = await net(), me = n.sessions.find((s) => s.id === from);
		return n.ps.find((p) => p.pane_id === me?.herdrLocation?.paneId)?.workspace_id;
	};
	const resolve = (device: unknown) => {
		const holder = o.link()?.holder;
		if (typeof device !== "string" || !device) return { ok: false as const, error: "a device is named by its label, short id, or id" };
		return holder ? holder.resolveTeammate(device) : { ok: false as const, error: "No link holder is running" };
	};
	return {
		router,
		holder: {
			// Only a workspace whose tower the server runs routes a wait: a resident pi tower holds no identity to wake mains or answer the device with, and its ledger would be swept by nobody (BMWR-F002).
			take: (item, ws) => router.take(item, served(ws)), orphan: (item, asker, ws) => router.orphan(item, asker, served(ws)),
			openOn: (device) => {
				const by: Record<string, string[]> = {};
				for (const ws of listServices(o.slot)) for (const w of readWaits(o.slot, ws.workspace).entries) if (w.dir === "in" && w.device === device && w.handle && isOpen(w)) (by[w.handle] ??= []).push(`L${w.n}`);
				return by;
			},
			// C4: a box's notice about an ask this computer made reaches the main that asked, in a line the server writes; the notice itself stays in the Link notices.
			notice: (n) => {
				const ask = o.asks?.find(n.ref);
				if (!ask || ask.device !== n.device) return;
				const why = n.kind === "inbox-stuck" ? "it waits in its inbox and no run took it yet" : n.kind === "inbox-refused" ? "no tower could be opened for it there" : "it sent a notice about it (the Link notices show it)";
				void o.towers()?.post(ask.workspace, [ask.for], `${restrictLabel(n.label)} could not take your message yet: ${why}. Your ask stays open; its answer still comes to you.`, "link_notice", { peer: { label: restrictLabel(n.label), short: n.device.slice(0, 6) } });
			},
		},
		async op(body, from) {
			try {
				switch (body.op) {
					case "device-resolve": {
						// `raise` (a main's `waitsOn`): a main an ally run opened raises a wait on its opener only (allywait.ts).
						const target = resolve(body.device), no = body.raise === true && target.ok ? raiserRefusal(o.slot, from, target, o.now()) : undefined;
						return no ? { ok: false, error: no } : target;
					}
					case "wait-act": return { ok: true, text: await router.act(from, String(body.id ?? ""), body.state, typeof body.message === "string" ? body.message : undefined) };
					case "wait-cancel": {
						const target = resolve(body.device);
						if (!target.ok) return target;
						const count = await router.cancel(from, target.id);
						return { ok: true, count, text: count ? `Withdrew ${count} open wait${count > 1 ? "s" : ""} to ${target.label}; it is told.` : `You have no open wait to ${target.label}.` };
					}
					case "waits-read": {
						const teams = Array.isArray(body.teams) ? (body.teams.filter((t) => typeof t === "string") as string[]) : undefined;
						if (teams) return { ok: true, waits: router.view({ teams }) };
						const ws = await wsOf(from);
						return { ok: true, waits: ws ? router.view({ workspaces: [ws] }) : [] };
					}
					case "standing-send": {
						// D13: a main's `call_tower` `standing`: a question (why blocked) or a notice (milestone) for a teammate device's standing main, sent by the code as the workspace's tower identity; an opened main reaches only its opener.
						const n = await net(), me = n.sessions.find((s) => s.id === from), pane = me && n.ps.find((p) => p.pane_id === me.herdrLocation?.paneId), ws = pane?.workspace_id, identity = ws ? o.towers()?.identityOf(ws) : undefined;
						if (!me || pane?.tokens?.sb_role !== "main" || !ws) return { ok: false, error: "Only a main of this computer calls a teammate's standing main this way" };
						const link = o.link(), target = resolve(body.device), kind = body.kind === "question" || body.kind === "notice" ? body.kind : undefined;
						if (!target.ok) return target;
						if (!kind) return { ok: false, error: "standing is a question (why blocked) or a notice (why milestone)" };
						const no = raiserRefusal(o.slot, from, target, o.now());
						if (no) return { ok: false, error: no };
						if (!identity || !link || !o.asks?.open) return { ok: false, error: "The sb server runs no tower for your workspace or no link holder, so nothing was sent" };
						const asks = { open: o.asks.open.bind(o.asks) };
						const sent = await sendStanding({ now: o.now, ws, identity, link: (b) => link.request(b, identity, true), asks, waits: router, log: o.log }, target, kind, String(body.message ?? ""), String(body.what ?? ""), { id: from, name: nameOf(me) || from });
						// The moment a notice goes past a wait the sender holds from that device (field 2026-11-26: box 1 told the Mac's standing main each step of nine of its questions): say where a note on it goes.
						const held = kind === "notice" ? router.ofDevice(target.id).filter((w) => w.dir === "in" && w.wait && (w.kind === "wait" || w.kind === "question") && (w.claimedBy ? w.claimedBy.id === from : !!w.toldTo?.some((m) => m.id === from))).map((w) => `L${w.n}`) : [];
						return { ok: true, ...sent, ...(held.length ? { text: `${sent.text} You hold ${held.join(", ")} from ${restrictLabel(target.label)}: a note on one goes in its thread (linkWait state note), to the main there that waits on it, not to its standing main; done or declined closes it.` } : {}) };
					}
					default: return { ok: false, error: "unknown request" };
				}
			} catch (error) {
				return { ok: false, error: (error as Error).message };
			}
		},
	};
}
