import { isSub, panes, parentOf, place, workspaces } from "./herdr.ts";
import type { Kit } from "./state.ts";
import type { createReach } from "./reach.ts";
import { ownFile } from "./netdata.ts";
import { slotOf, towerId } from "./server/record.ts";
import { towerRunsEnabled } from "./server/towerruns.ts";
import type { Request, Reply } from "./server/socket.ts";

/** A human's open-and-focus command. A linked checkout never joins and can only view an existing parent tower. */
export async function focusTower({ cfg, s, guiDir }: Kit, join: () => Promise<void>, reach: ReturnType<typeof createReach>, existing: (req: Request) => Promise<Reply>) {
	const here = await place(cfg.run), all = await workspaces(cfg.run), own = all.find(w => w.workspace_id === here.workspaceId);
	let tab: string | undefined;
	if (own && isSub(own)) {
		const parent = parentOf(all, own);
		if (!parent?.tokens?.tower) throw new Error("The parent workspace has no live tower");
		const dir = cfg.stateDir ?? guiDir, holder = parent.tokens.tower;
		if (holder !== towerId(slotOf(dir, cfg.env), parent.workspace_id)) {
			const resident = (await panes(cfg.run, parent.workspace_id)).find(p => p.agent === "pi" && ownFile(p.agent_session?.value, holder) && p.tokens?.sb_role === "tower");
			if (!resident) throw new Error("The parent workspace has no live resident tower");
			await cfg.run(["tab", "focus", resident.tab_id]); return;
		}
		if (!towerRunsEnabled(dir)) throw new Error("The tower service is off");
		const reply = await existing({ cmd: "view-existing-tower", workspace: parent.workspace_id, holder: parent.tokens.tower, view: true });
		if (!reply.ok || typeof reply.tab !== "string" || !reply.tab) throw new Error(String(reply.error ?? "The parent tower has no viewer"));
		tab = reply.tab;
	} else {
		await join();
		const tower = await reach.openTower(undefined, true, true, true);
		tab = ("tab" in tower && tower.tab) || (await s.c.listSessions()).find(x => x.id === tower.id)?.herdrLocation?.tab?.id;
	}
	if (!tab) throw new Error("The tower has no viewer tab to focus");
	await cfg.run(["tab", "focus", tab]);
}
