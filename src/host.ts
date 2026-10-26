import { popBase, stashedList } from "./stash.ts";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { Bridge } from "./bridge.ts";
import { createCloser } from "./closer.ts";
import { createDeploys } from "./deploy.ts";
import { createHub } from "./dialogs.ts";
import { type Gui, startGui } from "./gui.ts";
import { adoptable, adoptGui, downgrades, type Keep, markReload, markStopped, readRecord, type Shared, sharedGui, stopRecorded } from "./handover.ts";
import { herdrSocket } from "./endpoint.ts";
import type { Link } from "./link/runtime.ts";
import type { Membership } from "./membership.ts";
import { type Net, netSource } from "./net.ts";
import { pairingKeys, showLines } from "./pairing.ts";
import { identity, switchRemote } from "./remote.ts";
import { createSpawn } from "./spawn.ts";
import { trustDir } from "./trust/files.ts";
import { createTrustServe } from "./trust/serve.ts";
import { type Channel, type Kit, REGISTER } from "./state.ts";

/** This session hosts the straw net GUI: the one server per machine it starts or hands over, its remote entry, and the `/boss gui` commands. */
export function createHost({ pi, cfg, s, guiDir, me, tell }: Kit, { bridge, connected, link }: { bridge: Bridge; connected: Membership["connected"]; link: Link }) {
	const { run, world, sleep, call, tailscale: ts, copy, openUrl, version, bundle } = cfg;
	let opening: Promise<Shared> | undefined;
	// /boss gui is a read-only viewer: any session may open it, and it joins nothing and writes no token. A session outside the net
	// reads the sessions through a channel of its own that never takes part in a tab (no owner, no role).
	const sessions = async () => {
		if (!s.c && !s.viewer) {
			const namespace = `straw-boss/view/${Buffer.from(cfg.env.HERDR_PANE_ID!).toString("hex")}`;
			pi.events.emit(REGISTER, { namespace, ownerEligible: false, onReady: (channel: Channel) => (s.viewer = channel), onEvent: () => {} });
			if (!s.viewer) throw new Error("pi-intercom is not loaded (Straw Boss needs pi-intercom >= 0.17.1)");
			await connected(s.viewer);
		}
		return (s.c ?? s.viewer!).listSessions();
	};
	const unsaved = (gui: Gui) => ((reason) => reason && tell(reason, "warning"))(gui.access.unsaved()); // a paired.json that could not be saved: what was just changed is lost at a restart
	const label = () => `${me() || "unknown"} (pane ${cfg.env.HERDR_PANE_ID})`;
	const herdr = herdrSocket(cfg.env); // the Herdr server this session's net is read from; gui.json names it, and only a session on the same one adopts
	// The project trust questions the panes of this Herdr leave in <state>/trust (trust/serve.ts), and the openings the page runs, which a question for their pane belongs to.
	const deploys = createDeploys(), trust = createTrustServe({ dir: trustDir(guiDir), herdr, world: () => world(), opening: deploys.openingOf });
	// This session's server stops, its remote entry first: /boss gui stop here, or another session's stop or takeover (`asked`). A stop is on purpose and says so in
	// gui.json, so no survivor starts the server again (adoptGui); a takeover starts its own at once, and the session's end is not a stop (release).
	const stopOwn = async (asked?: { by: string; take: boolean }) => {
		const running = s.gui;
		s.gui = undefined;
		if (!running) return false;
		const record = readRecord(guiDir);
		if (!asked?.take && record?.pid === process.pid && record.port === running.port && record.token === running.token) markStopped(guiDir, record); // before the server stops answering, so a session that sees it down finds the mark
		const off = await switchRemote(running, false, guiDir, ts, true).catch((error: Error) => ({ text: error.message, changed: true }));
		if (off.changed) tell(off.text);
		await running.stop();
		tell(!asked ? "Straw net GUI stopped" : asked.take ? `The straw net GUI moved to session ${asked.by}` : `Straw net GUI stopped from session ${asked.by}`);
		return true;
	};
	// A server that starts here picks up where the last one left off: remote access comes back when it was wanted on (no QR; a failure is told, and the wish
	// stays for the next start), and a serve entry a crashed server left goes when it was not. It comes back only as the Tailscale identity the devices
	// were paired under: as another one (a different tailnet or user signed in) it stays off and says so, leaving the wish and the old devices for when
	// that identity returns; turning remote on by hand as the new identity (`/boss gui remote`) voids them. `was` is a /reload from a build of
	// 0.32.1 or earlier, whose gui.json said remote was on though its paired.json (written only once a device paired) may not exist.
	const resume = async (gui: Gui, was = false) => {
		if (!gui.access.wanted && !was) return void (await switchRemote(gui, false, guiDir, ts, true).catch(() => {}));
		try {
			const [now, remembered] = [await identity(ts), gui.access.remembered];
			if (remembered && (remembered.host !== now.host || remembered.login !== now.login)) {
				await switchRemote(gui, false, guiDir, ts, true).catch(() => {});
				return void tell(`Remote access stays off: the Tailscale identity is now ${now.login} on ${now.host}, not ${remembered.login} on ${remembered.host} that the paired devices belong to; sign in as that identity again, or turn it on here with /boss gui remote (that unpairs the old devices)`, "warning");
			}
			tell((await switchRemote(gui, true, guiDir, ts)).plain);
		} catch (error) {
			tell(`Remote access stays off: ${(error as Error).message}; it is tried again when the server next starts`, "warning");
		}
	};
	/** Straw Link's teammates, notices, and waiting confirms ride on the net snapshot (net.ts `Net.link`); a holder that says nothing leaves the net as it was. */
	const linked = async (net: Net): Promise<Net> => {
		const summary = await link.summary();
		return summary && (summary.allies.length || summary.alerts.length || summary.confirms.length) ? { ...net, link: summary } : net;
	};
	const start = (prefer: { port?: number; remotePort?: number; token?: string; csrf?: string }, net = netSource({ run, world, sessions, stashed: () => stashedList(guiDir), trust, hub: (s.hub = s.hub?.me === me() ? s.hub : createHub(pi, me(), bridge)) })) => startGui({ read: async () => linked(await net.read()), net, call, link: { call: (name, args) => link.gui(name, args), enable: () => link.enable() }, hub: s.hub, trust: { answer: trust.answer, watch: trust.watch }, dir: bundle, paired: join(guiDir, "paired.json"), ...prefer, onStop: (asked) => void stopOwn(asked), onSaveFailed: (reason) => tell(reason, "warning"), onRemote: async () => tell((await switchRemote(s.gui!, true, guiDir, ts)).text), onRemoteOff: async () => tell((await switchRemote(s.gui!, false, guiDir, ts)).text), spawn: createSpawn({ run, sleep, call, deploys, trustDir: trustDir(guiDir), live: async (id) => (await sessions()).some((x) => x.id === id), sessionAt: async (pane) => (await sessions()).find((x) => x.herdrLocation?.paneId === pane)?.id }), close: createCloser({ run, sleep, me, sessions, ask: async (key, keepPane, ifStashable) => s.hub?.close(key, keepPane, ifStashable), check: async (key) => s.hub?.stashCheck(key), stateDir: guiDir, pop: (name) => popBase({ run, sleep, stateDir: guiDir, live: async (id) => (await sessions()).some((x) => x.id === id), agentDir: cfg.env.PI_CODING_AGENT_DIR }, name) }) });
	// One server per machine: a second /boss gui, here or in another session, opens the one that runs, unless `take` (or a newer version) takes it
	// over. Two calls in flight in this session share one start. `manual`: the caller turns remote on or off itself, so a new server does not resume it.
	let adopting: Promise<void> | undefined, leaving = false;
	// A server whose owner's start time could not be told (`ps` failed; on Windows, PowerShell) has no `started` in its record, so no survivor adopts it: said once.
	let blind = false;
	const noticed = (shared?: Shared) => void shared?.late?.then((written) => !written && !blind && ((blind = true), tell("This session could not record its own start time, so no other session takes the straw net GUI over if this session ends; /boss gui starts it again", "warning")));
	// `keep` (handover.ts): a call that leaves a stopped or down server as it is does not hand its answer to one that starts it, so a /boss gui that finds such a call in flight waits for it.
	const share = async (take = false, manual = false, was = false, keep?: Keep): Promise<Shared> => {
		while (opening && leaving && !keep) await opening.then(() => {}, () => {});
		if (!opening) leaving = Boolean(keep);
		return (opening ??= (async () => {
			await adopting; // an adoption under way is this session's start
			if (s.gui) return { url: s.gui.url, owner: label(), mine: s.gui };
			const shared = await sharedGui(guiDir, [label(), me()], start, sleep, { version, take, herdr, keep });
			noticed(shared);
			if ((s.gui = shared.mine) && !manual) await resume(s.gui, was);
			return shared;
		})().finally(() => (opening = undefined)));
	};
	// The server belongs to the machine, not to the session that started it. When that session ends without a stop (a closed pane, a quit, a crash), a survivor starts the server
	// again on the same URL (handover.ts adoptGui), with remote access as `resume` leaves it, no QR, and no browser. Every session looks once every `adoptMs`; gui.lock lets exactly
	// one of them start it. It is left alone when the record says it was stopped on purpose, when `adoptable` (handover.ts) says no (an old build's record, another Herdr's, a newer build's), and while the session
	// that ran it lives: a /reload, /new, or /resume brings it back in that process, so a survivor never takes it from a reload. Only an interactive session adopts: a pi-herdr-agents subagent never reaches this host (index.ts), as it is
	// short-lived and its parent is the session to host, and neither does a print-mode run, whose end is just as near and whose screen would not show the notice.
	// Towers outlive the sessions they open, so the host is biased toward them and away from the churn of a short-lived session: a tower takes the server at the first look that finds its owner
	// gone, anyone else at the second, and a build older than the server at the third, by which time any newer survivor has taken it (the next newer session takes it back).
	let looking: ReturnType<typeof setInterval> | undefined, refused: string | undefined, seen = { key: "", looks: 0 };
	const adopt = async () => {
		if (s.gui || s.stopped || s.closing || !s.hasUI || !me() || opening || adopting) return;
		const wrote = statSync(join(guiDir, "gui.json"), { throwIfNoEntry: false })?.mtimeMs, record = readRecord(guiDir);
		if (!wrote || !record || record.stopped || !adoptable(record, { herdr }) || !cfg.gone(record, wrote) || refused === `${record.pid}/${wrote}`) return void (seen = { key: "", looks: 0 });
		const key = `${record.pid}/${wrote}`;
		seen = { key, looks: seen.key === key ? seen.looks + 1 : 1 };
		if (seen.looks <= (downgrades(record, version) ? 2 : s.isTower ? 0 : 1)) return;
		await (adopting = (async () => {
			let shared: Shared | undefined;
			try {
				shared = await adoptGui(guiDir, [label(), me()], start, sleep, cfg.gone, { version, herdr });
			} catch (error) {
				refused = `${record.pid}/${wrote}`; // told once; /boss gui tries again
				return tell(`Could not take over the straw net GUI after session ${record.owner} ended: ${(error as Error).message}; /boss gui starts it`, "warning");
			}
			if (!shared?.mine) return;
			noticed(shared);
			s.gui = shared.mine;
			tell(`This session now hosts the straw net GUI: session ${shared.from} ended, ${shared.moved ? `and its port was taken meanwhile, so the URL changed: ${shared.url}` : "and the URL is unchanged"}`);
			await resume(s.gui);
		})().finally(() => (adopting = undefined)));
	};
	const older = (owner: string) => `The straw net GUI runs in session ${owner} on a pi-straw-boss older than 0.11.0, which cannot hand it over; /reload that session or run the command there`;
	return {
		sessions,
		share,
		/** The server again after a /reload, /new, /resume, or a takeover by a newer version; remote access comes back with it when it was wanted on, and the paired devices are still paired. */
		async restore(was = false, keep?: Keep) {
			await share(false, false, was, keep);
		},
		/** `mode` is "", "stop", "remote", or "remote off", and works from any session: remote access (remote.ts) goes with the server, so a session takes it over first. */
		async command(mode: string) {
			if (mode === "stop") {
				if (await stopOwn()) return;
				const { state, record } = await stopRecorded(guiDir, label(), sleep); // under gui.lock: a survivor that is starting the server finishes first
				if (state === "down") return tell("The straw net GUI is not running");
				return tell(state === "stopped" ? `Straw net GUI stopped (it ran in session ${record!.owner})` : older(record!.owner));
			}
			const { url, owner, stale } = await share(mode.startsWith("remote"), mode.startsWith("remote"));
			if (mode.startsWith("remote") && !s.gui) return tell(older(owner));
			if (stale) tell(older(owner), "warning");
			if (mode === "remote off") {
				tell((await switchRemote(s.gui!, false, guiDir, ts)).text);
				return void unsaved(s.gui!);
			}
			if (mode === "remote") {
				const { text, lines, link } = await switchRemote(s.gui!, true, guiDir, ts), block = (active: boolean) => pi.events.emit("herdr:blocked", { active, label: "Showing the remote pairing QR code" });
				tell(text);
				unsaved(s.gui!);
				return void (lines && link && s.ui && (await showLines(s.ui, lines, { block, keys: pairingKeys(link, copy, openUrl) })));
			}
			tell(`Straw net GUI: ${url}`);
			await openUrl(url).catch((error: Error) => tell(`Could not open a browser (${error.message}); open the URL above yourself`, "warning"));
		},
		/** Starts looking for a server to take over (every `adoptMs`, until `release`); a session start again in this instance looks anew. */
		watch() {
			clearInterval(looking);
			looking = setInterval(() => void adopt().catch(() => {}), cfg.adoptMs).unref();
		},
		/** The session ends: a /reload, /new, or /resume (`reload`) marks the server to start again in this process, and the server stops with its remote entry. */
		async release(reload: boolean) {
			clearInterval(looking);
			await adopting; // a server this session was starting to adopt stops with it, instead of outliving it
			if (s.gui && reload) markReload(guiDir); // a /reload, /new, or /resume starts it again in this process
			if (s.gui) await switchRemote(s.gui, false, guiDir, ts, true).catch(() => {}); // the entry goes with the server; remote stays wanted and the devices stay paired
			await s.gui?.stop();
			s.gui = undefined;
		},
	};
}
