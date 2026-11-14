import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startBridge } from "./bridge.ts";
import { interceptUi } from "./intercept.ts";
import { registerDeclined } from "./declined.ts";
import { createAuto } from "./auto.ts";
import type { Ask } from "./host.ts";
import { serverAsk } from "./autoask.ts";
import { registerBoss } from "./boss.ts";
import { registerChildKind } from "./childkind.ts";
import { createBoardFill } from "./boardfill.ts";
import { createBriefing } from "./briefing.ts";
import { createCloseMain } from "./closemain.ts";
import { createDigest } from "./digest.ts";
import { afterExit, createClosing } from "./closing.ts";
import { createElection } from "./election.ts";
import { createIntegrationWatch } from "./integration.ts";
import { createGuard, GUARD_MS, RESTORE_WAIT_MS } from "./guard.ts";
import { openBrowser, VERSION } from "./gui.ts";
import { warmStart } from "./startof.ts";
import { copyText } from "./pairing.ts";
import { createHost } from "./host.ts";
import { herdrApi, herdrCall, herdrRun, herdrWorld, socketRun, worldOf } from "./herdr.ts";
import { createLink } from "./link/runtime.ts";
import { createMainDuty } from "./mainduty.ts";
import { createMembership } from "./membership.ts";
import { createPresence } from "./presence.ts";
import { createReach } from "./reach.ts";
import { createRunMode } from "./runmode.ts";
import { createRoles } from "./roles.ts";
import { slotOf } from "./server/record.ts";
import { herdrEvents, herdrWatch } from "./server-watch.ts";
import { createServerLook } from "./server-look.ts";
import { registerSession } from "./session.ts";
import { createStashing } from "./stashing.ts";
import { createBossPaths } from "./bosspaths.ts";
import { type Config, createKit, type Deps } from "./state.ts";
import { createTools } from "./tools.ts";
import { createTower } from "./tower.ts";
import { registerTrainGuard, registerTrainSigns, type TrainGuard } from "./trainguard.ts";
import { carLink, trainCarTool } from "./traincar.ts";
import { registerTrust } from "./trust/ask.ts";
import { registerWatchdog } from "./watchdog.ts";

export type { Deps } from "./state.ts";

const NUDGE_MS = 15_000;
const DETECT_MS = 1_000;
const ADOPT_MS = 2_000;
const INTEGRATION_MS = 20_000;
const JOIN_RETRY_MS = [1_000, 2_000, 5_000, 15_000];

// The composition root: the concerns live in their own modules (state.ts says what they share), and this wires them for one pi session.
export function createStrawBoss({ run: given, world: reading, api = herdrApi(), call = herdrCall(), copy = copyText, env = process.env, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), promptDir = fileURLToPath(new URL("../prompts", import.meta.url)), openUrl = openBrowser, watch = herdrWatch(), stateDir, autoTower = true, nudgeMs = NUDGE_MS, version = VERSION, guardMs = GUARD_MS, couple = true, events = herdrEvents(), detectMs = DETECT_MS, now = Date.now, later = afterExit, adoptMs = ADOPT_MS, restoreMs = RESTORE_WAIT_MS, integrationMs = INTEGRATION_MS, joinRetryMs = JOIN_RETRY_MS, link, server = given ? null : {}, ask, startRead, runSide, face }: Deps = {}) {
	// A run that is not injected is the real CLI, with its listings over the socket; an injected one answers everything itself, listings included.
	const run = given ?? socketRun(herdrRun, call), world = reading ?? (given ? worldOf(given) : herdrWorld(call));
	const cfg: Config = { run, world, api, call, copy, env, sleep, promptDir, openUrl, watch, stateDir, autoTower, nudgeMs, version, guardMs, couple, events, detectMs, now, later, adoptMs, restoreMs, integrationMs, joinRetryMs, link, server, ask, startRead, runSide, face };
	return function strawBoss(pi: ExtensionAPI): void {
		// Outside Herdr there is no tab to coordinate. Every session in Herdr relays its dialogs to the GUI (bridge.ts), subagents too: they ask
		// questions as well. A pi-herdr-agents worker never joins: its parent represents it.
		if (env.PI_SUBAGENT_ID) registerWatchdog(pi, env); // every child, a Core-launched one with no pane too: the watch tools and a watchdog's boundary (watchdog.ts), inert in any other child
		if (!env.HERDR_PANE_ID) return;
		const kit = createKit(pi, cfg), { s, guiDir } = kit;
		// Closing is this session's own: the GUI asks its bridge, /boss close asks here, and only a session that runs this extension can (not a subagent).
		let closeSelf: ((keepPane: boolean) => string | undefined) | undefined;
		// Dialogs go to the GUI in the sb server, whose gui.json (in this session's slot of the state directory) names its intercom session; no hub runs in a session.
		const bridge = startBridge(pi, { env, dir: slotOf(guiDir, env).dir, local: () => undefined, close: (keep) => (closeSelf ? closeSelf(keep) : "A subagent is closed by the session that launched it.") });
		// Auto mode (auto.ts) is registered first of the guards and holds in every pi in Herdr, subagents included: it follows auto.json, refuses what would wait for the boss, and reaches the server through the session's look, or a plain ask where it has none.
		const declined = registerDeclined(pi); // a cancel with no words may be a slipped Esc (declined.ts), subagents included
		let lookAsk: Ask | undefined, runKind: (() => string | undefined) | undefined; // the session's look at the server and its run's kind, assigned below once the session is no subagent
		const auto = createAuto(kit, { declined, bridge, silent: () => runKind?.() === "ally", ask: cfg.ask ?? ((request, options) => (lookAsk ?? serverAsk(kit))(request, options)) });
		s.autoOn = auto.on;
		registerTrust(pi, kit, undefined, auto.trust); // pi's startup trust question reaches the GUI too, before any session has joined the net (trust/ask.ts), subagents included
		interceptUi(pi, auto); // any extension's select and confirm reach the same bridge, subagents included
		if (env.PI_SUBAGENT_ID) return void (registerChildKind(pi, env), auto.attach()); // a child records its role for the net (childkind.ts)
		// A pi the sb server started for a tower run (runmode.ts) decides first, at session_start: when it is a run, nothing of the net starts.
		warmStart(); // Windows tells a process's start time through PowerShell, 2 to 3 s: read this one's now, in the background, so the records written later carry it
		const roles = createRoles(kit);
		registerTrainSigns(kit, roles); // first of the session_start handlers: the sign of a train is held before any of them awaits
		auto.attach(); // the follow of auto.json and its transition come after it
		const mainDuty = createMainDuty(kit), link = createLink(kit), briefing = createBriefing(kit, mainDuty), look = cfg.server ? createServerLook(kit, cfg.server) : undefined, runMode = createRunMode(kit, look, cfg.runSide, link), reach = createReach(kit, look), election = createElection(kit), presence = createPresence(kit, mainDuty), digest = createDigest(run, now);
		lookAsk = look?.ask;
		auto.running(() => runMode.active());
		runKind = () => runMode.kind;
		mainDuty.promptsOff(() => briefing.off());
		mainDuty.onWrite(({ from, to, why }) => (kit.s.isMain && roles.remember("main"), briefing.rebrief(), void presence.publish(), void digest.note(kit.s.at.workspaceId, `${kit.s.ownName || pi.getSessionName() || kit.me().slice(0, 8)} kind ${from ?? "none"}→${to}: ${why}`).catch(() => {})));
		look?.holdWhile(() => runMode.mode === "run" || Boolean(pi.getFlag("sb-run")));
		const guard = createGuard(kit, { ...election, openTower: reach.openTower, roles });
		// A join adds the tools of a joined session, and the tools promote through the membership: each is built with the other's hook.
		// The cars' way to the sb server (traincar.ts): the integrator's and the trains' `train_car` tool, added at the join, and the guard's source for notices.
		const cars = carLink(kit);
		let trainGuard: TrainGuard | undefined;
		const addTrainCar = trainCarTool(kit, () => trainGuard, cars, (text) => reach.callTower(text, undefined, false, "blocked"));
		const membership = createMembership(kit, { presence, election, guard, briefing, roles, openTower: reach.openTower, register: () => (tools.addNetTools(), tools.addPromote(), tools.addDuty(), addTrainCar()), onMain: link.look, control: () => control });
		// `look` (above) starts and upgrades the sb server (src/server/) and is the way to it; a session that is no part of that has none.
		const tools = createTools(kit, { ...reach, mainDuty, promote: membership.promote, digest, closeMain: (query) => control.closeMain(query), link, server: look, boardFill: createBoardFill(kit) });
		const host = createHost(kit, { connected: membership.connected, ask: cfg.ask ?? look?.ask });
		closeSelf = createClosing(kit);
		const control = createCloseMain(kit, { closeSelf, check: bridge.stashCheck, turn: bridge.turn });
		registerSession(kit, { mainDuty, integration: createIntegrationWatch(kit), runMode, briefing, roles, presence, membership, guard, host, reach, digest, control, startTower: createTower(kit, { membership, presence, tools, control, digest, roles, reach }) });
		trainGuard = registerTrainGuard(kit, cars.client, mainDuty);
		mainDuty.trainOn(() => Boolean(trainGuard)); // a train's todo and MonitorCreate calls, and the integrator's train todos (nothing loads with the merge train off)
		registerBoss(kit, { runMode, host, membership, reach, closeSelf, stashing: createStashing(kit, { host }), server: look, paths: createBossPaths(kit, { host, server: look, closeSelf, here: host.here }) });
	};
}

export default createStrawBoss();
