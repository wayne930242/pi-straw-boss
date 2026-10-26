import { createTab, type HerdrRun, panes, report, type Sleep, startPi, tabs, TOWER_LABEL, type Workspace, workspaces } from "./herdr.ts";
import { waitPastTrust } from "./trust/wait.ts";

export interface TowerEnv { run: HerdrRun; sleep: Sleep; live(sessionId: string): Promise<boolean>; moveFirst(tabId: string): Promise<void>; model?: string; trustDir?: string }

const TOWER_WAIT_MS = 60_000;
const opening = new Map<string, Promise<{ id: string; opened: boolean }>>();

/** The live tower of a workspace, opening its `tower` tab when there is none. One opening at a time per workspace. */
export function ensureTower(env: TowerEnv, workspace: Workspace, cwd: string) {
	const existing = opening.get(workspace.workspace_id);
	if (existing) return existing;
	const pending = open(env, workspace, cwd).finally(() => opening.delete(workspace.workspace_id));
	opening.set(workspace.workspace_id, pending);
	return pending;
}

async function open({ run, sleep, live, moveFirst, model, trustDir }: TowerEnv, workspace: Workspace, cwd: string) {
	const ws = workspace.workspace_id;
	const held = async () => {
		const id = (await workspaces(run)).find((w) => w.workspace_id === ws)?.tokens?.tower;
		return id && (await live(id)) ? id : undefined;
	};
	const current = await held();
	if (current) return { id: current, opened: false };

	// A leftover tower tab is reused: a pane already running pi only needs its token awaited, a shell prompt gets pi started.
	// The tab is told apart by the `sb_role=tower` pane token that only Straw Boss writes; a tab merely labelled "tower"
	// (a pi-herdr-agents subagent can be named so) is someone else's. A tab whose token was cleared (its tower quit) is still ours when it has
	// exactly the tower label (the glyph), one pane, and no agent in it.
	let paneId: string, created: string | undefined;
	let running = false;
	const here = await panes(run, ws);
	const marked = here.find((p) => p.tokens?.sb_role === "tower");
	const bare = marked ? [] : (await tabs(run, ws)).filter((t) => t.label === TOWER_LABEL).flatMap((t) => {
		const inside = here.filter((p) => p.tab_id === t.tab_id);
		return inside.length === 1 && !inside[0]!.agent && !inside[0]!.tokens?.sb_role ? [inside[0]!] : [];
	});
	const reused = marked ?? bare[0];
	if (reused) {
		paneId = reused.pane_id;
		running = reused.agent === "pi";
		if (!marked) await report(run, "pane", paneId, { sb_role: "tower" });
		await moveFirst(reused.tab_id);
		// Other shell-only leftovers are closed; failing to close one leaves a harmless tab, so it does not stop the tower.
		for (const extra of bare.slice(1)) await run(["tab", "close", extra.tab_id]).catch(() => {});
	} else {
		const dir = workspace.worktree?.checkout_path ?? cwd;
		const made = await createTab(run, ws, dir, ["STRAW_BOSS_ROLE=tower"], TOWER_LABEL);
		paneId = made.paneId;
		created = made.tabId;
		// Marked at once, so a tab left without pi is recognised (while the marker lasts) and the label stays display only.
		await report(run, "pane", paneId, { sb_role: "tower" });
		await moveFirst(made.tabId);
	}
	if (!running) {
		// Herdr agent names are unique across workspaces and lowercase only, so the name carries the lowercased workspace id.
		// An adopted shell that turns out busy (the user runs something there) gives the token back, so the next open does not count it as the tower.
		await startPi(run, sleep, `tower-${ws.toLowerCase()}`, paneId, ["--name", `tower · ${workspace.label}`, ...(model ? ["--model", model] : [])]).catch(async (error: unknown) => {
			if (reused && !marked) await report(run, "pane", paneId, { sb_role: null }).catch(() => {});
			throw error;
		});
	}
	// A trust question the tower waits on is not counted (trust/wait.ts); one nobody answers fails the opening, and a tab this opening made goes with it (a leftover tab is the user's to keep).
	const id = await waitPastTrust(sleep, held, TOWER_WAIT_MS, 1000, trustDir ? { dir: trustDir, pane: paneId } : undefined).catch(async (error: unknown) => {
		if (created) await run(["tab", "close", created]).catch(() => {});
		throw error;
	});
	if (!id) throw new Error(`The tower of ${workspace.label} did not publish its token within ${TOWER_WAIT_MS / 1000} s (pane ${paneId})`);
	return { id, opened: true };
}
