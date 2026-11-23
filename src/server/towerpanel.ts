import type { TowerPanel } from "../control.ts";
import { HEAD_KEY } from "../headkey.ts";
import type { HerdrRun } from "../herdr.ts";
import type { RunDialog, TowerView } from "../net.ts";
import { directLine } from "./entrycmds.ts";
import type { Towers } from "./towers.ts";

/** What the server's own closes need of the service (closer.ts): the tower it runs has no pi to ask, so its Quit tower is the boss closing it. */
export interface TowerEnd {
	/** Whether the session id is the identity of a service tower (it has no bridge: a squad or a base is closed without asking it). */
	owns(id: string): boolean;
	/** The boss closes the tower (towers.ts `close`): its tab goes and the service ends, the base's mains becoming members again. */
	close(workspace: string): Promise<{ ok: boolean; error?: string }>;
	/** A main was closed from this server's page (closer.ts): the `opened` route an ally run left for it goes with it, whichever workspace's tower holds it. */
	forget(session: string): void;
}
/**
 * The page's way to the tower service (guihost.ts `tower`): the service's state and queue in the net, the composer, the notices' buttons, and the boss conversation's Leave and New. Every one is a function the pi interface
 * reaches too (`/boss tower <prompt>`, `retry`, `deliver`, `drop`, `leave`, `new`): the GUI adds none of its own. `towers` is read at each call, since the service is built after the GUI host and may be absent.
 */
export function towerPanel(towers: () => Towers | undefined, run?: HerdrRun): { view(workspace: string): TowerView | undefined } & TowerPanel & TowerEnd {
	const asked = async (run: (t: Towers) => object | Promise<object>): Promise<{ ok: boolean; error?: string; left?: boolean; fresh?: boolean; already?: boolean }> => {
		try {
			return { ok: true, ...(await run(towers()!)) };
		} catch (error) {
			return { ok: false, error: (error as Error).message };
		}
	};
	// A service that waits for a resident tower is not the workspace's tower yet (the runs hold it from the moment it is adopted): the page shows the resident as it did before the service, with its own bridge, terminal, and composer.
	const serving = (workspace: string) => towers()?.stateOf(workspace) !== "waiting";
	// The head tower's stand-in for a workspace id is `HEAD_KEY` (headroutes.ts): its service is under the Herdr workspace it stands in now, and a message makes that workspace when there is none.
	const at = (t: Towers, workspace: string) => {
		if (workspace !== HEAD_KEY) return workspace;
		const ws = t.head.status()?.workspace;
		if (!ws) throw new Error("The head tower is not open: its first message opens it.");
		return ws;
	};
	/** The dialogs this page may answer: a tower's own runs', or every run's on the head's page (its own first). */
	const dialogsOf = (t: Towers | undefined, workspace: string): RunDialog[] => {
		const kids = t?.runs.headless() ? t.runs.kids() : undefined;
		if (!t || !kids) return [];
		const head = workspace === HEAD_KEY || t.head.status()?.workspace === workspace, own = head ? t.head.status()?.workspace : workspace;
		const labels = new Map(t.status().map((r) => [r.workspace, r.label] as const));
		const kindOf = (d: { kind?: string; workspace: string }): RunDialog["run"] => (d.kind === "ally" ? "ally" : d.kind === "head" || d.workspace === t.head.status()?.workspace ? "head" : "local");
		const labelOf = (d: { run: string; workspace: string }, kind: RunDialog["run"]) => (kind === "ally" ? t.runs.view(d.workspace)?.allyRuns.find((a) => a.id === d.run)?.label : labels.get(d.workspace));
		return kids.dialogs(head ? undefined : workspace).sort((a, b) => Number(b.workspace === own) - Number(a.workspace === own)).map((d) => {
			const run = kindOf(d), label = labelOf(d, run);
			return { key: d.key, workspace: d.workspace, method: d.method, title: d.title, ...(d.message ? { message: d.message } : {}), ...(d.options ? { options: d.options } : {}), ...(d.approval ? { approval: true as const } : {}), at: d.at, run, ...(label ? { label } : {}), ...(d.wait ? { wait: d.wait } : {}) };
		});
	};
	return {
		view: (workspace) => (serving(workspace) ? towers()?.runs.view(workspace) : undefined),
		has: (workspace) => (workspace === HEAD_KEY ? towers() !== undefined : serving(workspace) && towers()?.runs.view(workspace) !== undefined),
		// The head is a tower service under its Herdr workspace, yet only api/head/… reaches it (review HH3-F003): the tower routes ask this to refuse its key and its workspace.
		isHead: (workspace) => workspace === HEAD_KEY || (towers()?.head.status()?.workspace === workspace),
		owns: (id) => towers()?.owns(id) ?? false,
		forget: (session) => towers()?.forget(session),
		close: (workspace) => asked(async (t) => (await (workspace === HEAD_KEY ? t.head.close() : t.close(at(t, workspace))), {})),
		// A tower has a terminal while a run is live in its pane; with headless runs, while a viewer pane runs (runs have none).
		live: (workspace) => Boolean(towers() && (workspace !== HEAD_KEY || towers()!.head.status()) && ((t, ws) => (t.runs.headless() ? t.runs.view(ws)?.viewer : t.runs.status(ws)?.run))(towers()!, at(towers()!, workspace))),
		// The composer is the boss at a keyboard: the same boss event as the tower prompt's (`present`), so a conversation starts or goes on (docs/how-it-works.md, The boss conversation). With headless runs this
		// computer's own page is a door (`page`), as a viewer is: a run may then show the boss a card (runmode.ts `boss_wait_ask`). With them off the page names none, as in 0.84.0.
		event: (workspace, text, door) => asked(async (t) => {
			const at = door && t.runs.headless() ? door : undefined;
			return (workspace === HEAD_KEY ? await t.head.event(text, undefined, at) : t.runs.boss(workspace, text, "the boss (GUI)", { present: true, ...(at ? { door: at } : {}) }), {});
		}),
		// Headless runs (docs/specs/2026-11-23-f-entry.md §2.8): what a run writes now, its dialogs and their answer from this page, a viewer tab, and the head composer's `@<workspace>`. Each is refused or empty with the switch off.
		liveText: (workspace) => { const t = towers(); try { return t?.runs.headless() ? t.runs.kids()?.liveText(at(t, workspace)) ?? "" : ""; } catch { return ""; } },
		dialogs: (workspace) => dialogsOf(towers(), workspace),
		answer: (workspace, key, reply) => asked((t) => {
			if (!dialogsOf(t, workspace).some((d) => d.key === key)) throw new Error("That dialog is not waiting any more (it was answered, cancelled, or its run ended).");
			if (!t.runs.kids()?.answer(key, reply)) throw new Error("That answer is not one the dialog takes (a select takes one of its options, an approval a yes or a no).");
			return {};
		}),
		viewer: (workspace) => asked(async (t) => {
			if (!t.runs.headless()) throw new Error("A viewer needs headless tower runs (towerRuns.headless in config.json); the standing pane is the tower's tab.");
			if (workspace === HEAD_KEY || t.head.status()?.workspace === workspace) throw new Error("The head's viewer is its crown tab: /boss head opens it.");
			await t.ensure({ workspace, view: true });
			return {};
		}),
		direct: (to, text, door) => asked(async (t) => {
			if (!t.runs.headless() || !run) throw new Error("@<workspace> needs headless tower runs (towerRuns.headless in config.json)");
			return { label: (await directLine(t, run, to, text, door)).label };
		}),
		conversation: (workspace, what) => asked((t) => (what === "leave" ? t.runs.leave(at(t, workspace)) : t.runs.fresh(at(t, workspace)))),
		// The GUI's route is the one door that is the page; the control socket's `tower-memory` says which of pi's, the prompt's, or a run pane's it is (main.ts).
		memory: (workspace, json) => towers()!.memory(workspace, json, "gui"),
		act: (workspace, what, id) => asked((t) => ((ws) => (what === "retry" ? t.runs.retry(ws) : what === "deliver" ? t.runs.deliverAgain(ws, id!) : t.runs.dropParked(ws, id!), {}))(at(t, workspace))),
	};
}
