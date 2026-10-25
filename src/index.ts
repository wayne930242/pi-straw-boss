import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startBridge } from "./bridge.ts";
import { interceptUi } from "./intercept.ts";
import { registerBoss } from "./boss.ts";
import { createBriefing } from "./briefing.ts";
import { createCloseMain } from "./closemain.ts";
import { createDigest } from "./digest.ts";
import { afterExit, createClosing } from "./closing.ts";
import { createElection } from "./election.ts";
import { createGuard, GUARD_MS } from "./guard.ts";
import { openBrowser, VERSION } from "./gui.ts";
import { ownerGone } from "./handover.ts";
import { copyText } from "./pairing.ts";
import { createHost } from "./host.ts";
import { herdrApi, herdrCall, herdrRun, herdrWorld, socketRun, worldOf } from "./herdr.ts";
import { createMembership } from "./membership.ts";
import { createPresence } from "./presence.ts";
import { createReach } from "./reach.ts";
import { createRoles } from "./roles.ts";
import { tailscale } from "./remote.ts";
import { herdrEvents, herdrWatch } from "./server-watch.ts";
import { registerSession } from "./session.ts";
import { createStashing } from "./stashing.ts";
import { type Config, createKit, type Deps } from "./state.ts";
import { createTools } from "./tools.ts";
import { createTower } from "./tower.ts";

export type { Deps } from "./state.ts";

const NUDGE_MS = 15_000;
const DETECT_MS = 1_000;
const ADOPT_MS = 2_000;

// The composition root: the concerns live in their own modules (state.ts says what they share), and this wires them for one pi session.
export function createStrawBoss({ run: given, world: reading, api = herdrApi(), call = herdrCall(), tailscale: ts = tailscale, copy = copyText, env = process.env, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), promptDir = fileURLToPath(new URL("../prompts", import.meta.url)), bundle, openUrl = openBrowser, watch = herdrWatch(), stateDir, autoTower = true, nudgeMs = NUDGE_MS, version = VERSION, guardMs = GUARD_MS, couple = true, events = herdrEvents(), detectMs = DETECT_MS, now = Date.now, later = afterExit, gone = ownerGone(), adoptMs = ADOPT_MS }: Deps = {}) {
	// A run that is not injected is the real CLI, with its listings over the socket; an injected one answers everything itself, listings included.
	const run = given ?? socketRun(herdrRun, call), world = reading ?? (given ? worldOf(given) : herdrWorld(call));
	const cfg: Config = { run, world, api, call, tailscale: ts, copy, env, sleep, promptDir, bundle, openUrl, watch, stateDir, autoTower, nudgeMs, version, guardMs, couple, events, detectMs, now, later, gone, adoptMs };
	return function strawBoss(pi: ExtensionAPI): void {
		// Outside Herdr there is no tab to coordinate. Every session in Herdr relays its dialogs to the GUI (bridge.ts), subagents too: they ask
		// questions as well. A pi-herdr-agents worker never joins: its parent represents it.
		if (!env.HERDR_PANE_ID) return;
		const kit = createKit(pi, cfg), { s, guiDir } = kit;
		// Closing is this session's own: the GUI asks its bridge, /boss close asks here, and only a session that runs this extension can (not a subagent).
		let closeSelf: ((keepPane: boolean) => string | undefined) | undefined;
		const bridge = startBridge(pi, { env, dir: guiDir, local: () => (s.hub?.running ? s.hub : undefined), close: (keep) => (closeSelf ? closeSelf(keep) : "A subagent is closed by the session that launched it.") });
		interceptUi(pi); // any extension's select and confirm reach the same bridge, subagents included
		if (env.PI_SUBAGENT_ID) return;
		const briefing = createBriefing(kit), roles = createRoles(kit), reach = createReach(kit), election = createElection(kit), presence = createPresence(kit), digest = createDigest(run, now);
		const guard = createGuard(kit, { ...election, openTower: reach.openTower });
		// A join adds the tools of a joined session, and the tools promote through the membership: each is built with the other's hook.
		const membership = createMembership(kit, { presence, election, guard, briefing, roles, openTower: reach.openTower, register: () => (tools.addNetTools(), tools.addPromote()) });
		const tools = createTools(kit, { ...reach, promote: membership.promote, digest, closeMain: (query) => control.closeMain(query) });
		const host = createHost(kit, { bridge, connected: membership.connected });
		closeSelf = createClosing(kit);
		const control = createCloseMain(kit, { closeSelf, check: bridge.stashCheck });
		registerSession(kit, { briefing, roles, presence, membership, guard, host, reach, digest, control, startTower: createTower(kit, { membership, presence, tools, control, digest, roles }) });
		registerBoss(kit, { host, membership, reach, closeSelf, stashing: createStashing(kit, { host }) });
	};
}

export default createStrawBoss();
