import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { alive } from "./remote.ts";
import { boardState, readTrainboards, trainboardDir } from "./train/board.ts";
import { createTab, report, panes, startPi, type HerdrRun, type Pane, type Session, type Sleep, workspaces } from "./herdr.ts";
import { ForwardAsBefore, INTEGRATOR, integMark, integratorHandoff, integratorOf, keptIntegrators, ledgerProjects, liveIntegrator, MAX_OPENED_INTEGRATORS } from "./integrator.ts";
import { type CoordinatorDuty, isCoordinatorDuty } from "./duty.ts";
import { assertSettingsSafe, SettingsRefused } from "./trust/settings.ts";
import { inside } from "./link/routing.ts";
import { checkoutProject, noTrainRefusal, openRefusal, repoRoot } from "./train/appsconfig.ts";
import { slipsInText } from "./train/cars.ts";
import { appFromRequest, isRoleLabel, readMaxTrains, TRAIN, type TrainId, trainFromRequest, trainFromToken, trainLabel, trainToken } from "./trainrole.ts";
import { waitPastTrust } from "./trust/wait.ts";

// The one thing a tower does besides routing: when no session owns a request, it opens a main for it (docs/how-it-works.md, "Opening a main").
// It is narrow on purpose: one new tab in the tower's own workspace, started without focus, in which Straw Boss starts pi. It types into no pane
// that already exists, and `STRAW_BOSS_ROLE=main` makes that pi promote itself once it has joined (index.ts).

const MAIN_WAIT_MS = 60_000;
/** At most this many mains opened by towers are alive in one workspace, and at most one per sender. */
const MAX_OPENED_MAINS = 2;
/** The wait before the second look for a project's integrator where its ledger says one ran and none is seen. */
const INTEGRATOR_REREAD_MS = 2_000;

/** A limit was hit: nothing opened, and the same request may be tried again once an opened main has finished. A folder pi must not start in (SettingsRefused) is refused the same way. */
class OpenLimitError extends Error {}

export interface OpenerEnv {
	run: HerdrRun;
	sleep: Sleep;
	/** The tower's own workspace: a request for another workspace goes to that workspace's tower. */
	workspaceId: string;
	/** Where the new pi runs when the workspace has no checkout path of its own. */
	cwd: string;
	sessions(): Promise<Session[]>;
	send(to: string, message: string): Promise<{ status: string; code?: string; detail?: string }>;
	/** The tower itself: the main reports to it as well as to the sender, and it closes the main afterwards (closemain.ts). */
	tower(): { id: string; name: string };
	/** <state>/trust: a trust question the new pi waits on (trust/ask.ts) stops the wait counting, and ten minutes without an answer fail the opening. */
	trustDir?: string;
	/** Whether the merge train is off on this computer (trainswitch.ts): a train is refused then. Without it the opener never refuses on that account. */
	integrationOff?(): boolean;
	/** The state folder whose `trainboard/` the train quota and the once-per-code rule read (§19); without it only the panes speak. */
	stateDir?: string;
	/** `maxTrains` of the project whose checkout is `dir`, or the refusal in words (trainrole.ts `readMaxTrains`, apps.json). */
	maxTrains?(dir: string): number | { refusal: string };
	/** The refusal of the manifest's app in the project's apps.json (`stages` that still list `uat`, an `integration.accept` that is no list), or undefined (appsconfig.ts `openRefusal`). */
	appsRefusal?(dir: string, app: string | undefined): string | undefined;
	/**
	 * The sb server keeps the ledger of a workspace on disk (docs/specs/2026-10-26-sb-backend.md, State), so a request already tried is not tried again after the server restarts:
	 * `entries` are the outcomes of the last 24 h, and `put` records one as it ends. Without it (a tower session) the ledger lives for the session.
	 */
	ledger?: { entries(): LedgerRow[]; put(row: LedgerRow): void };
}
/** A request's outcome as the ledger keeps it: the key is the hash of the sender and the request. */
export interface LedgerRow { key: string; sender: string; outcome: "opened" | "failed"; at: number; opened?: Opened; error?: string }
/** A teammate's device that is the sender (an ally run opens a main for the device it serves): not a session of this computer, so it is not looked up among them, and the main reports to the tower alone. Only the server sets it, from the run's own claim. */
export interface PeerSender { id: string; label: string; short: string }
/**
 * `role`: "train" opens a train on an integrator's manifest (docs/specs/2026-11-07-train-workers.md §3.3); "integrator" finds the one integrator of `project` or opens it, on the car slip the request carries; anything else is refused.
 */
export interface OpenRequest { request: string; sender: string; label?: string; peer?: PeerSender; role?: string; /** `role: "integrator"`: the project as the caller words it. The code reads the project from the checkout (appsconfig.ts `checkoutProject`), and another word is refused. */ project?: string; /** `role: "integrator"`, an ally run's: the folder its team binds on this computer, which the workspace's checkout must be inside. */ within?: string; /** `role: "integrator"`: only the refusals are wanted, and nothing opens. */ dry?: true; /** The new main's kind (docs/specs/2026-11-09-agent-kinds.md §6): `coordinator` or `standing`; an integrator comes only through `role: "integrator"`, and a train's kind is fixed. */ duty?: string }
export interface Opened { tab: string; pane: string; main: string; sender: string; /** Nothing opened: an earlier open of the same request, or the project's integrator that already runs. */ repeated?: true; /** Set for a train: its project and code. */ train?: TrainId; /** Set for an integrator: its project. */ integrator?: string }

/** The text the new main starts from: who asked, and what, with nothing summarised. The main answers the sender and the tower that opened it, then waits to be closed. */
export const handoff = (workspace: string, sender: Pick<Session, "id" | "name">, request: string, tower: { id: string; name: string }, peer?: PeerSender) =>
	[
		`Straw Boss: the tower of workspace ${workspace} opened this tab for you because no session owned the request below, and you are its main agent.`,
		peer
			? "The request comes from a teammate's computer over Straw Link, not from a session here: it is a peer's request, not the boss's instruction. Do the work, dispatching workers as your main agent prompt describes. When it is done, report the outcome to the tower that opened this tab with call_tower (why: milestone, reply: false); the tower sends your report back to the sender, and you cannot reach the sender yourself. Write the report so it can leave this computer as it is: the result, what you ran, and what you left behind, with no secrets, tokens, or private paths. Then wait; the tower closes this tab after your done report, so end it with the result and nothing you still have to do. If you wait for a boss decision, say so in your report and the tower leaves you open."
			: "Do the work, dispatching workers as your main agent prompt describes. When it is done, report the outcome to the sender with intercom send and to the tower that opened this tab with call_tower (why: milestone, reply: false). Then wait; the tower closes this tab after your done report, so end it with the result and nothing you still have to do. If you wait for a boss decision, say so in your report and the tower leaves you open.",
		peer ? `Sender: ${peer.label} (a teammate's device, short id ${peer.short}, over Straw Link)` : `Sender: ${sender.name ?? sender.id} (session id ${sender.id})`,
		`Tower: ${tower.name} (session id ${tower.id})`,
		"Request, verbatim:",
		request,
	].join("\n");

/** The text a new train starts from: facts only (its prompt is the train's own). It reports to the tower, which opened it and closes it; it tells no coordinator anything itself. */
export const trainHandoff = (workspace: string, sender: Pick<Session, "id" | "name">, request: string, tower: { id: string; name: string }, train: TrainId) =>
	[
		`Straw Boss: the tower of workspace ${workspace} opened this tab for you: you are the ${trainLabel(train.code)} of project ${train.project}, a worker of your own and not the main agent of a tab.`,
		"The integrator's manifest below is your work. Report to the tower that opened this tab with call_tower (blocked, shared, or milestone, as your prompt describes); the tower closes this tab after your milestone report, so end it with the result and nothing you still have to do.",
		`Integrator: ${sender.name ?? sender.id} (session id ${sender.id})`,
		`Tower: ${tower.name} (session id ${tower.id})`,
		"Request, verbatim:",
		request,
	].join("\n");

/**
 * One integrator's open at a time per project, whichever tower's opener asks (the sb server is one process, and every tower's opener is in it): the look for the project's live integrator and the marker of a new one
 * cannot interleave between two workspaces, so the second open finds the first one's main (R151-F003).
 */
const opening = new Map<string, Promise<void>>();
/** Waits for the project's turn; the open calls what it returns when it has ended, however it ended. */
async function projectTurn(project: string): Promise<() => void> {
	const before = opening.get(project) ?? Promise.resolve();
	let done!: () => void;
	const mine = new Promise<void>((resolve) => (done = resolve)), tail = before.then(() => mine);
	opening.set(project, tail);
	await before;
	return () => (done(), void (opening.get(project) === tail && opening.delete(project)));
}

/**
 * Opens a main for a request, once, within the limits above. The same sender and request never open a second main, whether the first attempt is still running, succeeded,
 * or failed (a failed attempt closes the tab it created and is not retried: the sender hears of it instead). A refused one (a limit, or a folder pi must not start in) created nothing and may be asked again.
 */
export function opener(env: OpenerEnv) {
	const seen = new Map<string, Promise<Opened>>();
	for (const row of env.ledger?.entries() ?? []) {
		const prior = row.outcome === "opened" && row.opened ? Promise.resolve(row.opened) : Promise.reject(new Error(row.error ?? "the earlier attempt failed"));
		prior.catch(() => {});
		seen.set(row.key, prior);
	}
	const open = async (input: OpenRequest): Promise<Opened> => {
		const turn: { end?: () => void } = {};
		try { return await openHeld(input, turn); } finally { turn.end?.(); }
	};
	const openHeld = async ({ request, sender: asked, label: asked_label, peer, role, project, within, dry, duty }: OpenRequest, turn: { end?: () => void }): Promise<Opened> => {
		const { run, sleep } = env;
		if (role !== undefined && role !== TRAIN && role !== INTEGRATOR) throw new OpenLimitError(`role must be "train" or "integrator" when given, not ${JSON.stringify(role).slice(0, 40)}`);
		// The kind the new main starts with (§6): it reaches the pi as `sb_open_duty`, consumed with `sb_open_main` (session.ts). A project's integrator is opened by the door alone, which keeps one per project.
		if (duty !== undefined && !isCoordinatorDuty(duty)) throw new OpenLimitError(`duty must be "coordinator" or "standing" when given, not ${JSON.stringify(duty).slice(0, 40)}`);
		if (duty !== undefined && role === TRAIN) throw new OpenLimitError("A train's kind is fixed: train; open it with no duty");
		if (duty === INTEGRATOR && role !== INTEGRATOR) throw new OpenLimitError("An integrator is opened with role \"integrator\" on a car slip, which keeps one per project; duty takes coordinator or standing");
		const openDuty: CoordinatorDuty | undefined = role === INTEGRATOR ? INTEGRATOR : (duty as CoordinatorDuty | undefined);
		// A train is opened on the tower's own reading of an integrator's manifest, and only while the merge train is on; its name is its code, whatever label the caller sent.
		let train: TrainId | undefined, label = asked_label;
		if (role === TRAIN) {
			if (peer) throw new OpenLimitError("A train is opened for a session of this computer, not for a teammate's device");
			if (env.integrationOff?.()) throw new OpenLimitError("A train cannot be opened: integration is off on this computer");
			const found = trainFromRequest(request);
			if ("refusal" in found) throw new OpenLimitError(found.refusal);
			train = found;
			label = trainLabel(found.code);
		}
		// The label becomes the new tab's, and a tab labelled as a tower's or a train's is what proves that role after a restore (roles.ts): a main's tab is never given one (a train's is its code's, above).
		if (!train && label !== undefined && isRoleLabel(label.trim())) throw new OpenLimitError("label is the label of a tower's or a train's tab, which only Straw Boss gives; choose another");
		// An integrator is opened on a car slip a session of this computer sent, for the project of the workspace's checkout (read below); its tab and session carry the project's name, which makes the new pi an integrator from its first turn (mainduty.ts).
		if (role === INTEGRATOR) {
			if (peer) throw new OpenLimitError("An integrator is opened on a car slip a session of this computer sent, not for a teammate's device");
			if (env.integrationOff?.()) throw new OpenLimitError("No integrator is opened: integration is off on this computer");
		}
		let sender: Pick<Session, "id" | "name">;
		if (peer) sender = { id: asked, name: peer.label };
		else {
			const matches = (await env.sessions()).filter((s) => s.id === asked || s.name === asked);
			if (matches.length !== 1) throw new Error(`${matches.length ? "Several sessions are named" : "No live session is named or has the id"} "${asked}", so the new main could not report back to it`);
			sender = matches[0]!;
			// The integrators' marker is the opener's own (below): a main opened for a session whose id reads as one would be taken for a project's integrator.
			if (integratorOf(sender.id)) throw new OpenLimitError(`The id of sender ${sender.name ?? sender.id} reads as an integrator's marker (${integMark("<project>")}), so no main is opened in its name`);
		}
		const workspace = (await workspaces(run)).find((w) => w.workspace_id === env.workspaceId);
		if (!workspace) throw new Error(`Workspace ${env.workspaceId} is not open any more`);
		// Limits come from live Herdr panes carrying the marker below, so they hold across a tower restart: a closed tab takes its marker with it, and
		// a main that died leaves one that expires with its token TTL. A restored main keeps its old marker (the asking session, now another id), so it counts toward the workspace cap only. Opens are serialised, so the count and the marker cannot race.
		const dir = workspace.worktree?.checkout_path ?? env.cwd;
		let integ: string | undefined, found: { from: string; file: string; apps: string[] } | undefined;
		if (role === INTEGRATOR) {
			// The slip's apps are this checkout's, and so is the project: apps.json says both, and the caller's word only has to agree (R151-F002). A made-up name opens nothing, and one checkout has one integrator's name.
			const slips = slipsInText(request);
			if (!slips.length) throw new OpenLimitError("An integrator is opened on a car slip: the request carries none (car: <app> | tickets: … | branch: … | head: <40 hex>)");
			// A field the parse could not take (a key that is no slip field, `app:` and `car:` naming two apps) is refused here with the parse's words, not dropped: the slip goes back to its sender as written (0.77.3).
			const unread = slips.flatMap((s) => s.problems ?? []);
			if (unread.length) throw new OpenLimitError(`The car slip cannot be taken as written: ${unread.join("; ")}. The slip's car: names the car's app (app: is the same field), and its tickets go in tickets:. A slip ends at a blank line: words of your own (\`Note: …\`) go after one, never on the line below the slip.`);
			const apps = [...new Set(slips.map((s) => s.app))], config = noTrainRefusal(dir, apps);
			if (config) throw new OpenLimitError(config);
			const own = checkoutProject(dir);
			if (!own.ok) throw new OpenLimitError(own.refusal);
			if (project !== undefined && project !== own.project) throw new OpenLimitError(`The project of this workspace's checkout is ${own.project} (${own.from}), not ${JSON.stringify(project).slice(0, 80)}: the slip of its app${apps.length === 1 ? "" : "s"} ${apps.join(", ")} goes to integ ${own.project} and to no other project's integrator.`);
			// An ally run's slip stays inside the project its team binds on this computer.
			if (within !== undefined && !inside(dir, within)) throw new OpenLimitError("An ally run's slip goes to the integrator of the project its team binds on this computer, and this workspace's checkout is outside that project: nothing opens and nothing is forwarded.");
			(integ = own.project), (label = `integ ${integ}`), (found = { from: own.from, file: own.file, apps });
			turn.end = await projectTurn(integ);
		}
		const here = await panes(run, workspace.workspace_id);
		if (train) {
			// A train has its own count, per project over the whole computer (D4): the project's live trains, from every workspace's panes that carry `sb_train` (so the limit survives a tower restart) and from the
			// live trainboards (a train whose pane is gone and whose board still says live is running). It takes none of the places of the mains, and has no limit per sender.
			const everywhere = await panes(run);
			const codes = new Set(everywhere.flatMap((p) => ((t) => (t && t.project === train!.project ? [t.code] : []))(trainFromToken(p.tokens?.sb_train))));
			if (codes.has(train.code)) throw new OpenLimitError(`The ${trainLabel(train.code)} of project ${train.project} is already open; a code is used once`);
			// A code is used once for good: the folder of its trainboard stays after the train ends, and holds the code.
			if (env.stateDir && existsSync(join(trainboardDir(env.stateDir), train.project, train.code))) throw new OpenLimitError(`The ${trainLabel(train.code)} of project ${train.project} was already used (its trainboard is kept); a code is used once, so the next train takes a new code`);
			const max = (env.maxTrains ?? readMaxTrains)(dir);
			if (typeof max !== "number") throw new OpenLimitError(max.refusal);
			// An app whose apps.json is still the 0.64.0 one (`uat` in stages) departs nothing: acceptance moved to the coordinator, and a train would carry cars nobody accepted (TB-F002).
			const config = (env.appsRefusal ?? openRefusal)(dir, appFromRequest(request));
			if (config) throw new OpenLimitError(config);
			const read = env.stateDir ? readTrainboards(env.stateDir, { project: train.project }) : { trains: [], unlisted: [] };
			// A folder that cannot be listed hides live trains: the count would be a guess, so nothing opens (RR-F004).
			if (read.unlisted.length) throw new OpenLimitError(`The live trains of project ${train.project} cannot be counted: ${read.unlisted.join("; ")}`);
			const boards = read.trains;
			for (const b of boards) if (b.ok && boardState(b.board, { now: Date.now(), alive: alive(b.board.writer.pid) }) === "live") codes.add(b.code);
			if (codes.size >= max) throw new OpenLimitError(`Project ${train.project} already has ${codes.size} live train${codes.size === 1 ? "" : "s"} (maxTrains is ${max}); try again when one has finished.`);
		}
		if (integ && found) {
			// A project that already runs integrators under names of their own (0.73: the boss's, one per app, such as integ FE2 and integ v3) keeps them: the door opens none beside them, counts none of them, and picks none, so the tower
			// forwards the slip as before. They are the unmarked mains of kind integrator in this workspace or in this checkout (an app's own repository below it counts); one named integ <project> alone is the project's one, below.
			const root = repoRoot(dir), mine = (p: Pane) => p.workspace_id === workspace.workspace_id || here.some((h) => h.pane_id === p.pane_id) || Boolean(p.cwd && (repoRoot(p.cwd) === root || inside(p.cwd, root)));
			const look = async () => ((everywhere: Pane[], sessions: Session[]) => ({ everywhere, sessions, kept: keptIntegrators(everywhere, sessions, mine), running: liveIntegrator(everywhere, sessions, integ!) }))(await panes(run), await env.sessions());
			let seen = await look();
			// A ledger of the project says an integrator has run its trains, and a kept one leaves no durable sign: when none is seen (one that restarts, or sits outside the workspace and the checkout), the door reads once more, and then opens one
			// only when no unmarked main of kind integrator is alive on the computer at all (a dead integrator must be replaceable). Otherwise it could open a second integrator on the same ledger (RR151-F003).
			if (!seen.kept.length && !seen.running && env.stateDir && found.apps.some((a) => ledgerProjects(env.stateDir!, a).includes(integ!))) {
				await sleep(INTEGRATOR_REREAD_MS);
				const others = keptIntegrators((seen = await look()).everywhere, seen.sessions, () => true);
				if (!seen.kept.length && !seen.running && others.length) throw new OpenLimitError(`No integrator of project ${integ} is seen in this workspace or its checkout, and its ledger (trains/${integ} in the state folder) says one has run its trains; ${others.map((k) => `${k.session.name ?? k.session.id} (session ${k.session.id})`).join(", ")} ${others.length === 1 ? "is a main" : "are mains"} of kind integrator elsewhere on this computer, so nothing opens beside ${others.length === 1 ? "it" : "them"}. Try again, or ask the boss: an integrator the project keeps sits in the tower's workspace or works in the checkout.`);
			}
			const { everywhere, sessions, kept } = seen;
			if (kept.some((k) => k.session.name !== `integ ${integ}`)) throw new ForwardAsBefore(integ, found.apps, kept.map((k) => ({ id: k.session.id, name: k.session.name ?? k.session.id })));
			// An app whose trains another project's integrator already keeps is that project's, whatever this checkout calls itself: the boss says in apps.json which project it is. The rule is about what the door opens, so it comes after the kept ones (RR151-F001).
			for (const [app, held] of found.apps.map((a) => [a, env.stateDir ? ledgerProjects(env.stateDir, a) : []] as const)) if (held.length && !held.includes(integ)) throw new OpenLimitError(`The trains of app ${app} are kept under project ${held.join(", ")} (trains/${held[0]}/${app}.json in the state folder), and this checkout's project reads ${integ} (${found.from}): its cars go to one integrator, so set integration.project in ${found.file} to the project that keeps them.`);
			// The project's one integrator, wherever on this computer it runs: the slip goes to it, and nothing opens.
			const running = seen.running;
			if (running && "refusal" in running) throw new OpenLimitError(running.refusal);
			// It works in this checkout's repository (a worktree of it counts), or it is another repository's integrator under the same name: no slip of this one goes to it.
			if (running && !(running.pane.cwd && repoRoot(running.pane.cwd) === repoRoot(dir))) throw new OpenLimitError(`The integrator of project ${integ} (${running.session.name ?? running.session.id}, session ${running.session.id}) works in ${running.pane.cwd ? `another repository (${running.pane.cwd})` : "a folder Herdr does not name"}, not in this workspace's (${repoRoot(dir)}): a project's integrator works in its project's checkout, so no slip goes to it. Give this checkout a name of its own (integration.project in ${found.file}), or the boss closes that one.`);
			if (running) return { tab: running.pane.tab_id, pane: running.pane.pane_id, main: running.session.id, sender: sender.id, integrator: integ, repeated: true };
			// The integrators a tower opened have a count of their own, per workspace, from the panes that carry the marker (so it holds across a tower restart).
			const opened = here.flatMap((p) => integratorOf(p.tokens?.sb_opened_by) ?? []);
			if (opened.length >= MAX_OPENED_INTEGRATORS) throw new OpenLimitError(`Workspace ${workspace.label} already has ${opened.length} integrators opened by its tower (${opened.join(", ")}; the limit is ${MAX_OPENED_INTEGRATORS}); try again when one has closed.`);
			// A dry look (an ally run's, before the boss is asked): every refusal above was told, and nothing opens.
			if (dry) return { tab: "", pane: "", main: "", sender: sender.id, integrator: integ, repeated: true };
		}
		// A train carries `sb_opened_by` as a main does (the tower closes it by that mark), but it counts toward neither of the mains' limits. It is the role that says it (a train in its first moments has none yet):
		// a main's pane with an `sb_train` token left on it (a crashed train's, or one a process of the same user wrote) is still a main.
		// An integrator the tower opened is the tower's own main: its marker names its project and no sender, and it takes none of the mains' places either (it has its own count, above).
		const marked = here.filter((p) => p.tokens?.sb_opened_by && !integratorOf(p.tokens.sb_opened_by) && p.tokens.sb_role !== TRAIN && !(p.tokens.sb_role === undefined && p.tokens.sb_train));
		const ofSender = train || integ ? 0 : marked.filter((p) => p.tokens!.sb_opened_by === sender.id).length;
		if (ofSender) throw new OpenLimitError(`Sender ${sender.name ?? sender.id} already has ${ofSender === 1 ? "an opened main" : `${ofSender} opened mains`} running in workspace ${workspace.label}; a sender gets one at a time. Wait for it to finish, or send the request to it.`);
		if (!train && !integ && marked.length >= MAX_OPENED_MAINS) throw new OpenLimitError(`Workspace ${workspace.label} already has ${marked.length} mains opened by its tower (the limit is ${MAX_OPENED_MAINS}); try again when one has finished.`);
		await assertSettingsSafe([dir]); // before the tab exists: pi reads the folder's .pi/settings.json before any extension can stop it (trust/settings.ts)
		const { tabId, paneId } = await createTab(run, workspace.workspace_id, dir, [`STRAW_BOSS_ROLE=${train ? TRAIN : "main"}`], label);
		try {
			// The marker counts toward the limits at once; sb_open_main authorises exactly one pi in this shell to promote itself (it consumes the token).
			await report(run, "pane", paneId, { sb_opened_by: integ ? integMark(integ) : sender.id, sb_open_main: "1", ...(train ? { sb_train: trainToken(train) } : {}), ...(openDuty ? { sb_open_duty: openDuty } : {}) });
			// Herdr agent names are unique across workspaces and lowercase only.
			await startPi(run, sleep, `${train ? TRAIN : integ ? "integ" : "main"}-${randomUUID().slice(0, 8)}`, paneId, ["--name", train || integ ? label! : `main · ${label ?? workspace.label}`]);
			// The pi is the tab's main (or the train) once it has published its role, and an integrator once it has published its kind too; only then does it get the request, so its first prompt is its own role's.
			const wanted = train ? TRAIN : "main";
			const main = await waitPastTrust(sleep, async () => {
				const tokens = (await panes(run, workspace.workspace_id)).find((p) => p.pane_id === paneId)?.tokens;
				return tokens?.sb_role === wanted && (!integ || tokens.sb_duty === INTEGRATOR) ? (await env.sessions()).find((s) => s.herdrLocation?.paneId === paneId) : undefined;
			}, MAIN_WAIT_MS, 500, env.trustDir ? { dir: env.trustDir, pane: paneId } : undefined);
			if (!main) throw new Error(`The pi in pane ${paneId} did not become ${train ? "the train" : integ ? `the integrator of project ${integ} (a main of kind integrator)` : "the main agent"} of its tab within ${MAIN_WAIT_MS / 1000} s`);
			const sent = await env.send(main.id, train ? trainHandoff(workspace.label, sender, request, env.tower(), train) : integ ? integratorHandoff(workspace.label, integ, env.tower()) : handoff(workspace.label, sender, request, env.tower(), peer));
			if (sent.status !== "sent") throw new Error(`The new ${train ? "train" : integ ? "integrator" : "main"} ${main.name ?? main.id} did not take the ${integ ? "handoff" : "request"}: ${sent.status} ${sent.code ?? ""} ${sent.detail ?? ""}`.trim());
			return { tab: tabId, pane: paneId, main: main.id, sender: sender.id, ...(train ? { train } : {}), ...(integ ? { integrator: integ } : {}) };
		} catch (error) {
			// Nothing was handed over, so no work is lost with the tab.
			await run(["tab", "close", tabId]).catch(() => {});
			throw error;
		}
	};
	let queue: Promise<unknown> = Promise.resolve();
	return (input: OpenRequest): Promise<Opened> => {
		// An integrator's open is answered from the live net each time and kept in no ledger: the project's integrator closes when idle, and the next slip, even the same one sent again, opens it anew. Opens stay serialised.
		if (input.role === INTEGRATOR) {
			const pending = queue.then(() => open(input), () => open(input));
			queue = pending.catch(() => {});
			return pending;
		}
		const key = createHash("sha256").update(JSON.stringify(input.role === TRAIN ? [input.sender, input.request, TRAIN] : [input.sender, input.request])).digest("hex");
		const prior = seen.get(key);
		if (prior) return prior.then((opened) => ({ ...opened, repeated: true as const }), (error: Error) => Promise.reject(new Error(`A main was already tried for this request and is not opened again: ${error.message}`)));
		const pending = queue.then(() => open(input), () => open(input));
		queue = pending.catch(() => {});
		seen.set(key, pending);
		// A refused request (a limit, or a folder pi must not start in) created nothing and may be asked again; every other outcome stays in the ledger.
		const row = (outcome: LedgerRow["outcome"], more: Pick<LedgerRow, "opened" | "error">): LedgerRow => ({ key, sender: input.sender, outcome, at: Date.now(), ...more });
		pending.then((opened) => env.ledger?.put(row("opened", { opened })), (error: Error) => {
			if (error instanceof OpenLimitError || error instanceof SettingsRefused) return seen.get(key) === pending && seen.delete(key);
			env.ledger?.put(row("failed", { error: error.message.slice(0, 300) }));
		}).catch(() => {});
		return pending;
	};
}
