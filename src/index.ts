import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startBridge } from "./bridge.ts";
import { registerBoss } from "./boss.ts";
import { createBriefing } from "./briefing.ts";
import { afterExit, createClosing } from "./closing.ts";
import { createElection } from "./election.ts";
import { createGuard, GUARD_MS } from "./guard.ts";
import { openBrowser, VERSION } from "./gui.ts";
import { copyText } from "./pairing.ts";
import { createHost } from "./host.ts";
import { herdrApi, herdrCall, herdrRun } from "./herdr.ts";
import { createMembership } from "./membership.ts";
import { createPresence } from "./presence.ts";
import { createReach } from "./reach.ts";
import { tailscale } from "./remote.ts";
import { herdrEvents, herdrWatch } from "./server-watch.ts";
import { registerSession } from "./session.ts";
import { type Config, createKit, type Deps } from "./state.ts";
import { createTools } from "./tools.ts";
import { createTower } from "./tower.ts";

export type { Deps } from "./state.ts";

const NUDGE_MS = 15_000;

// The composition root: the concerns live in their own modules (state.ts says what they share), and this wires them for one pi session.
export function createStrawBoss({ run = herdrRun, api = herdrApi(), call = herdrCall(), tailscale: ts = tailscale, copy = copyText, env = process.env, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), promptDir = fileURLToPath(new URL("../prompts", import.meta.url)), bundle, openUrl = openBrowser, watch = herdrWatch(), stateDir, autoTower = true, nudgeMs = NUDGE_MS, version = VERSION, guardMs = GUARD_MS, couple = true, events = herdrEvents(), now = Date.now, later = afterExit }: Deps = {}) {
	const cfg: Config = { run, api, call, tailscale: ts, copy, env, sleep, promptDir, bundle, openUrl, watch, stateDir, autoTower, nudgeMs, version, guardMs, couple, events, now, later };
	return function strawBoss(pi: ExtensionAPI): void {
		// Outside Herdr there is no tab to coordinate. Every session in Herdr relays its dialogs to the GUI (bridge.ts), subagents too: they ask
		// questions as well. A pi-herdr-agents worker never joins: its parent represents it.
		if (!env.HERDR_PANE_ID) return;
		const kit = createKit(pi, cfg), { s, guiDir } = kit;
		// Closing is this session's own: the GUI asks its bridge, /boss close asks here, and only a session that runs this extension can (not a subagent).
		let closeSelf: ((keepPane: boolean) => string | undefined) | undefined;
		const bridge = startBridge(pi, { env, dir: guiDir, local: () => (s.hub?.running ? s.hub : undefined), close: (keep) => (closeSelf ? closeSelf(keep) : "A subagent is closed by the session that launched it.") });
		if (env.PI_SUBAGENT_ID) return;
		const briefing = createBriefing(kit), reach = createReach(kit), election = createElection(kit), presence = createPresence(kit);
		const guard = createGuard(kit, { ...election, openTower: reach.openTower });
		// A join adds the tools of a joined session, and the tools promote through the membership: each is built with the other's hook.
		const membership = createMembership(kit, { presence, election, guard, briefing, openTower: reach.openTower, register: () => (tools.addNetTools(), tools.addPromote()) });
		const tools = createTools(kit, { ...reach, promote: membership.promote });
		const host = createHost(kit, { bridge, connected: membership.connected });
		closeSelf = createClosing(kit);
		registerSession(kit, { briefing, presence, membership, guard, host, reach, startTower: createTower(kit, { membership, presence, tools }) });
		registerBoss(kit, { host, membership, reach, closeSelf });
	};
}

export default createStrawBoss();
