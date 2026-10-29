import { workspaces } from "./herdr.ts";
import { memoryLang, runMemoryCommand } from "./memorycmd.ts";
import { parseTowerArgs, runTowerCommand } from "./towercmd.ts";
import { towerRunsEnabled } from "./server/towerruns.ts";
import type { createHost } from "./host.ts";
import type { Membership } from "./membership.ts";
import type { Reach } from "./reach.ts";
import type { ServerLook } from "./server-look.ts";
import type { Kit } from "./state.ts";
import type { createStashing } from "./stashing.ts";

/** What Tab completes after /boss; a bare /boss (take over as the main agent) has nothing to complete. */
const BOSS_ARGUMENTS = Object.entries({ status: "Show the coordinators", close: "Quit this session and close its pane", "close all": "Quit this base's tower, mains, and members and close it", tower: "Open and focus the workspace tower (tower <prompt> writes to it as the boss, with no focus change)", "tower status": "Show the tower's service, boss conversation, notices, and parked events", "tower parked": "List the events parked after two crashes", "tower retry": "Wake the tower again after a crash loop", "tower leave": "Leave the boss conversation (it ends with a note)", "tower new": "Start over: the next boss conversation is a new session", gui: "Open the net in the browser", "gui stop": "Close the browser GUI", "gui rotate": "Give the GUI a new address and unpair every phone", "gui remote": "Open the GUI to your phone over Tailscale", "gui remote off": "Close the Tailscale entry", server: "Show the sb server, and start it when it is down", "server stop": "Stop the sb server on purpose", "server restart": "Restart the sb server", memory: "Show the tower's memory (standing instructions, decisions, waits) and what the tower proposes", "memory confirm": "Confirm a proposal of the tower: memory confirm P1", "memory reject": "Reject a proposal of the tower: memory reject P1", "memory add standing": "Keep a standing instruction in your words", "memory add decision": "Keep a decision in your words", stash: "Put this base away: its tower, mains, and members", pop: "Open a stashed base again" }).map(([value, description]) => ({ value, label: value, description }));

/** The /boss command. */
export function registerBoss({ pi, cfg, s, guiDir, tell }: Kit, { runMode, host, membership, reach, closeSelf, stashing, server }: { runMode?: { active(): boolean }; host: ReturnType<typeof createHost>; membership: Membership; reach: Reach; closeSelf(keepPane: boolean): string | undefined; stashing: ReturnType<typeof createStashing>; server?: ServerLook }) {
	// D15: `/boss tower <prompt>` ensures the tower as a bare `/boss tower` does, then posts the prompt as a `boss` event, the way the GUI's composer does. Nothing is typed anywhere and focus stays.
	const handToTower = async (prompt: string) => {
		if (!server || !towerRunsEnabled(guiDir)) return tell("/boss tower <prompt> needs the tower runs (towerRuns.enabled in the state directory's config.json): the tower is a resident session now, so open it with /boss tower and write to it there.", "warning");
		if (prompt.length > 16_384) return tell("The prompt is longer than 16,384 characters; hand the tower a shorter one and name a file for the rest.", "error");
		await membership.joinNet();
		const tower = await reach.openTower(undefined, true, true);
		const answer = await server.ask({ cmd: "tower-event", workspace: tower.target.workspace_id, text: prompt, present: true }, { start: "boss" });
		if (!answer.ok) return tell(`The tower did not take the prompt: ${String(answer.error ?? "no answer")}`, "error");
		tell(`Handed to the tower${tower.opened ? " (it was opened for this)" : ""}: it reads the prompt as the boss's instruction in the boss conversation, which stays open while you write (/boss tower leave ends it).`);
	};
	// `/boss memory`: the boss's own interface to the tower's memory (memorycmd.ts); the GUI's panel is the same server op. It is the boss's typed input only: a tower run takes no /boss command.
	const memory = (args: string, interactive: boolean) => server
		? runMemoryCommand(args, {
			lang: memoryLang(cfg.env), interactive, own: s.at?.workspaceId, workspaces: () => workspaces(cfg.run), tell,
			ask: async (workspace, json) => {
				const r = await server.ask({ cmd: "tower-memory", workspace, json }, { start: "never" });
				return { ok: r.ok, ...(typeof r.error === "string" ? { error: r.error } : {}), ...(typeof r.status === "number" ? { status: r.status } : {}), ...(typeof r.body === "object" && r.body !== null ? { body: Object.fromEntries(Object.entries(r.body)) } : {}) };
			},
		})
		: Promise.resolve(tell("The sb server is not available in this session.", "warning"));
	// `/boss tower status | retry | parked | deliver <id> | drop <id> | leave | new` (towercmd.ts): the pi twins of the tower card's and composer's buttons, one control command each.
	const towerCommand = (parsed: NonNullable<ReturnType<typeof parseTowerArgs>>, interactive: boolean) => server
		? runTowerCommand(parsed, { lang: memoryLang(cfg.env), interactive, own: s.at?.workspaceId, tell, ask: async (request) => ({ ...(await server.ask(request, { start: "never" })) }) })
		: Promise.resolve(tell("The sb server is not available in this session.", "warning"));
	pi.registerCommand("boss", {
		description: "Take over as this tab's main agent (every session already joins as a member). /boss status shows the coordinators; /boss tower focuses the workspace tower (a main opens it when there is none); /boss tower <prompt> hands the prompt to the tower as the boss, starting or continuing the boss conversation, with no change of focus (/boss tower status, retry, parked, deliver <id>, drop <id>, leave, new); /boss close quits this session and closes its pane (/boss close all: this whole base, its tower, mains, and members); /boss stash [name] puts this base away (tower, mains, members) and /boss pop [name] opens it again; /boss gui opens the net in the browser (/boss gui stop closes it; /boss gui remote opens it to your phone over Tailscale, /boss gui remote off closes that); /boss server shows the sb server and starts it when it is down (/boss server stop, /boss server restart [reason]); /boss memory shows the tower's memory and what it proposes, and confirms or rejects a proposal (/boss memory confirm P1, reject P1), adds, edits, or deletes a standing instruction or decision, and resolves a wait (the GUI mirrors it).",
		// pi passes the whole argument text and replaces it with the chosen value, so each value is a full argument line.
		getArgumentCompletions: (prefix) => {
			const stashed = stashing.names().map((name) => ({ value: `pop ${name}`, label: `pop ${name}`, description: "Open this stashed base again" }));
			const items = [...BOSS_ARGUMENTS, ...stashed].filter((item) => item.value.startsWith(prefix.trimStart()));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			s.ui = ctx.ui;
			// A tower run is no part of the net: a bare /boss would promote it to a main in the tower tab.
			if (runMode?.active()) return tell("A tower run takes no /boss command: it is the server's, and it ends with tower_done.", "warning");
			try {
				if (/^gui( stop| rotate| remote( off)?)?$/.test(args.trim())) return await host.command(args.trim().slice(4));
				const sb = /^server(?:\s+(stop|restart)(?:\s+(.*))?)?$/.exec(args.trim());
				if (sb) return await (server ? server.command((sb[1] ?? "") as "" | "stop" | "restart", sb[2] ?? "") : tell("The sb server is not available in this session.", "warning"));
				const why = args.trim() === "close" ? (closeSelf(false) ?? "") : undefined;
				if (why !== undefined) return void (why && tell(why, "error"));
				if (args.trim() === "status") return tell(s.joined || s.isTower ? JSON.stringify(await reach.status(), null, 2) : "Not in the net: still joining, or this session cannot join.");
				if (args.trim() === "close all") return await stashing.closeAll();
				const mem = /^memory(?:\s+([\s\S]*))?$/.exec(args.trim());
				if (mem) return await memory(mem[1] ?? "", ctx.hasUI);
				const stash = /^(stash|pop)(?:\s+(.+))?$/.exec(args.trim());
				if (stash) return await (stash[1] === "stash" ? stashing.stash(stash[2]) : stashing.pop(stash[2]));
				const words = /^tower\s+([\s\S]+)$/.exec(args.trim())?.[1], found = words === undefined ? undefined : parseTowerArgs(words);
				if (found) return await towerCommand(found, ctx.hasUI);
				const prompt = /^tower\s+([\s\S]+)$/.exec(args.trim());
				if (prompt) return await handToTower(prompt[1]!);
				if (s.isTower) throw new Error("This session is the tower, not a main agent");
				if (args.trim() !== "tower") return tell((await membership.promote(true)).text);
				await membership.joinNet();
				const tower = await reach.openTower(undefined, true, true); // anyone may open the tower by hand; the boss's own command also starts a server that was stopped on purpose
				const where = (await s.c.listSessions()).find((x) => x.id === tower.id)?.herdrLocation;
				if (where?.tab) await cfg.run(["tab", "focus", where.tab.id]);
			} catch (error) {
				tell((error as Error).message, "error");
			}
		},
	});
}
