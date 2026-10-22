import type { createHost } from "./host.ts";
import type { Membership } from "./membership.ts";
import type { Reach } from "./reach.ts";
import type { Kit } from "./state.ts";
import type { createStashing } from "./stashing.ts";

/** What Tab completes after /boss; a bare /boss (take over as the main agent) has nothing to complete. */
const BOSS_ARGUMENTS = Object.entries({ status: "Show the coordinators", close: "Quit this session and close its pane", "close all": "Quit every tower, main, and member on the net and close their bases", tower: "Open and focus the workspace tower", gui: "Open the net in the browser", "gui stop": "Close the browser GUI", "gui remote": "Open the GUI to your phone over Tailscale", "gui remote off": "Close the Tailscale entry", stash: "Put this base away: its tower, mains, and members", pop: "Open a stashed base again" }).map(([value, description]) => ({ value, label: value, description }));

/** The /boss command. */
export function registerBoss({ pi, cfg, s, tell }: Kit, { host, membership, reach, closeSelf, stashing }: { host: ReturnType<typeof createHost>; membership: Membership; reach: Reach; closeSelf(keepPane: boolean): string | undefined; stashing: ReturnType<typeof createStashing> }) {
	pi.registerCommand("boss", {
		description: "Take over as this tab's main agent (every session already joins as a member). /boss status shows the coordinators; /boss tower focuses the workspace tower (a main opens it when there is none); /boss close quits this session and closes its pane (/boss close all: every tower, main, and member on the net); /boss stash [name] puts this base away (tower, mains, members) and /boss pop [name] opens it again; /boss gui opens the net in the browser (/boss gui stop closes it; /boss gui remote opens it to your phone over Tailscale, /boss gui remote off closes that).",
		// pi passes the whole argument text and replaces it with the chosen value, so each value is a full argument line.
		getArgumentCompletions: (prefix) => {
			const stashed = stashing.names().map((name) => ({ value: `pop ${name}`, label: `pop ${name}`, description: "Open this stashed base again" }));
			const items = [...BOSS_ARGUMENTS, ...stashed].filter((item) => item.value.startsWith(prefix.trimStart()));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			s.ui = ctx.ui;
			try {
				if (/^gui( stop| remote( off)?)?$/.test(args.trim())) return await host.command(args.trim().slice(4));
				const why = args.trim() === "close" ? (closeSelf(false) ?? "") : undefined;
				if (why !== undefined) return void (why && tell(why, "error"));
				if (args.trim() === "status") return tell(s.joined || s.isTower ? JSON.stringify(await reach.status(), null, 2) : "Not in the net: still joining, or this session cannot join.");
				if (args.trim() === "close all") return await stashing.closeAll();
				const stash = /^(stash|pop)(?:\s+(.+))?$/.exec(args.trim());
				if (stash) return await (stash[1] === "stash" ? stashing.stash(stash[2]) : stashing.pop(stash[2]));
				if (s.isTower) throw new Error("This session is the tower, not a main agent");
				if (args.trim() !== "tower") return tell((await membership.promote(true)).text);
				await membership.joinNet();
				const tower = await reach.openTower(undefined, true); // anyone may open the tower by hand
				const where = (await s.c.listSessions()).find((x) => x.id === tower.id)?.herdrLocation;
				if (where?.tab) await cfg.run(["tab", "focus", where.tab.id]);
			} catch (error) {
				tell((error as Error).message, "error");
			}
		},
	});
}
