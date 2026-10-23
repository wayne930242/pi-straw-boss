import { popBase, stashedList } from "./stash.ts";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { Bridge } from "./bridge.ts";
import { createCloser } from "./closer.ts";
import { createHub } from "./dialogs.ts";
import { type Gui, startGui } from "./gui.ts";
import { adoptGui, answers, markReload, markStopped, readRecord, requestStop, type Shared, sharedGui } from "./handover.ts";
import type { Membership } from "./membership.ts";
import { netSource } from "./net.ts";
import { pairingKeys, showLines } from "./pairing.ts";
import { identity, switchRemote } from "./remote.ts";
import { createSpawn } from "./spawn.ts";
import { type Channel, type Kit, REGISTER } from "./state.ts";

/** This session hosts the straw net GUI: the one server per machine it starts or hands over, its remote entry, and the `/boss gui` commands. */
export function createHost({ pi, cfg, s, guiDir, me, tell }: Kit, { bridge, connected }: { bridge: Bridge; connected: Membership["connected"] }) {
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
	// This session's server stops, its remote entry first: /boss gui stop here, or another session's stop or takeover (`asked`). A stop is on purpose and says so in
	// gui.json, so no survivor starts the server again (adoptGui); a takeover starts its own at once, and the session's end is not a stop (release).
	const stopOwn = async (asked?: { by: string; take: boolean }) => {
		const running = s.gui;
		s.gui = undefined;
		if (!running) return false;
		if (!asked?.take) markStopped(guiDir, running); // before the server stops answering, so a session that sees it down finds the mark
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
			tell((await switchRemote(gui, true, guiDir, ts)).text);
		} catch (error) {
			tell(`Remote access stays off: ${(error as Error).message}; it is tried again when the server next starts`, "warning");
		}
	};
	const start = (prefer: { port?: number; remotePort?: number; token?: string; csrf?: string }, net = netSource({ run, world, sessions, stashed: () => stashedList(guiDir), hub: (s.hub = s.hub?.me === me() ? s.hub : createHub(pi, me(), bridge)) })) => startGui({ read: net.read, net, call, hub: s.hub, dir: bundle, paired: join(guiDir, "paired.json"), ...prefer, onStop: (asked) => void stopOwn(asked), onSaveFailed: (reason) => tell(reason, "warning"), onRemote: async () => tell((await switchRemote(s.gui!, true, guiDir, ts)).text), onRemoteOff: async () => tell((await switchRemote(s.gui!, false, guiDir, ts)).text), spawn: createSpawn({ run, sleep, call, live: async (id) => (await sessions()).some((x) => x.id === id), sessionAt: async (pane) => (await sessions()).find((x) => x.herdrLocation?.paneId === pane)?.id }), close: createCloser({ run, sleep, me, sessions, ask: async (key, keepPane, ifStashable) => s.hub?.close(key, keepPane, ifStashable), check: async (key) => s.hub?.stashCheck(key), stateDir: guiDir, pop: (name) => popBase({ run, sleep, stateDir: guiDir, live: async (id) => (await sessions()).some((x) => x.id === id), agentDir: cfg.env.PI_CODING_AGENT_DIR }, name) }) });
	// One server per machine: a second /boss gui, here or in another session, opens the one that runs, unless `take` (or a newer version) takes it
	// over. Two calls in flight in this session share one start. `manual`: the caller turns remote on or off itself, so a new server does not resume it.
	let adopting: Promise<void> | undefined;
	const share = (take = false, manual = false, was = false) =>
		(opening ??= (async () => {
			await adopting; // an adoption under way is this session's start
			if (s.gui) return { url: s.gui.url, owner: label(), mine: s.gui };
			const shared = await sharedGui(guiDir, [label(), me()], start, sleep, { version, take });
			if ((s.gui = shared.mine) && !manual) await resume(s.gui, was);
			return shared;
		})().finally(() => (opening = undefined)));
	// The server belongs to the machine, not to the session that started it. When that session ends without a stop (a closed pane, a quit, a crash), a survivor starts the server
	// again on the same URL (handover.ts adoptGui), with remote access as `resume` leaves it, no QR, and no browser. Every session looks once every `adoptMs`; gui.lock lets exactly
	// one of them start it. It is left alone when the record says it was stopped on purpose, and while the session that ran it lives: a /reload, /new, or /resume brings it back in
	// that process, so a survivor never takes it from a reload. Only an interactive session adopts: a pi-herdr-agents subagent never reaches this host (index.ts), as it is
	// short-lived and its parent is the session to host, and neither does a print-mode run, whose end is just as near and whose screen would not show the notice.
	let looking: ReturnType<typeof setInterval> | undefined, refused: string | undefined;
	const adopt = async () => {
		if (s.gui || s.stopped || s.closing || !s.hasUI || !me() || opening || adopting) return;
		const wrote = statSync(join(guiDir, "gui.json"), { throwIfNoEntry: false })?.mtimeMs, record = readRecord(guiDir);
		if (!wrote || !record || record.stopped || !cfg.gone(record, wrote) || refused === `${record.pid}/${wrote}`) return;
		await (adopting = (async () => {
			let shared: Shared | undefined;
			try {
				shared = await adoptGui(guiDir, [label(), me()], start, sleep, cfg.gone, { version });
			} catch (error) {
				refused = `${record.pid}/${wrote}`; // told once; /boss gui tries again
				return tell(`Could not take over the straw net GUI after session ${record.owner} ended: ${(error as Error).message}; /boss gui starts it`, "warning");
			}
			if (!shared?.mine) return;
			s.gui = shared.mine;
			tell(`This session now hosts the straw net GUI: session ${shared.from} ended, and the URL is unchanged`);
			await resume(s.gui);
		})().finally(() => (adopting = undefined)));
	};
	const older = (owner: string) => `The straw net GUI runs in session ${owner} on a pi-straw-boss older than 0.11.0, which cannot hand it over; /reload that session or run the command there`;
	return {
		sessions,
		share,
		/** The server again after a /reload, /new, /resume, or a takeover by a newer version; remote access comes back with it when it was wanted on, and the paired devices are still paired. */
		async restore(was = false) {
			await share(false, false, was);
		},
		/** `mode` is "", "stop", "remote", or "remote off", and works from any session: remote access (remote.ts) goes with the server, so a session takes it over first. */
		async command(mode: string) {
			if (mode === "stop") {
				if (await stopOwn()) return;
				const record = readRecord(guiDir);
				if (!record || !(await answers(record))) {
					if (record && !record.stopped) markStopped(guiDir, record); // a server that is down may be about to be taken over: a stop is a stop all the same
					return tell("The straw net GUI is not running");
				}
				const stopped = await requestStop(record, { by: label(), take: false }, sleep);
				if (stopped) markStopped(guiDir, record); // its owner marks it too, unless it is a build from before this record knew
				return tell(stopped ? `Straw net GUI stopped (it ran in session ${record.owner})` : older(record.owner));
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
