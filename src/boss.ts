import { join } from "node:path";
import { boardCommand } from "./boardcmd.ts";
import { runHeadCommand, parseHeadArgs } from "./headcmd.ts";
import { tabs, workspaces } from "./herdr.ts";
import { memoryLang, runMemoryCommand } from "./memorycmd.ts";
import { runWaitCommand } from "./waitcmd.ts";
import { headAlias, parseTowerArgs, parseTowerLine, runTowerCommand, sayToTower, type TowerCmdDeps, towerUsage } from "./towercmd.ts";
import { towerRunsEnabled } from "./server/towerruns.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { createHost } from "./host.ts";
import type { Membership } from "./membership.ts";
import type { Reach } from "./reach.ts";
import type { ServerLook } from "./server-look.ts";
import type { Kit } from "./state.ts";
import type { createStashing } from "./stashing.ts";
import { type createBossPaths, parseStash } from "./bosspaths.ts";
import { parseAnswer } from "./bossanswer.ts";
import { LINK_ARGUMENTS } from "./bosslink.ts"; import { VIEW_ARGUMENTS } from "./bossviews.ts";
import { parseSend, parseStop } from "./bosssend.ts";
import { createBossAuto } from "./bossauto.ts";
import { asBoss } from "./autoscope.ts";
import { runRolesCheck } from "./rolescheck.ts";

/** What Tab completes after /boss; a bare /boss (take over as the main agent) has nothing to complete. */
const BOSS_ARGUMENTS = Object.entries({ status: "Show the coordinators", auto: "Show auto mode (the boss is away: nothing may wait for them)", "auto on": "Ask to start auto mode; you confirm in this terminal", "auto confirm": "Confirm a request the head tower staged", "auto off": "End auto mode and see what was parked", board: "Show the work board: each main's line, its done count and age, and the lines left behind (this computer only)", close: "Quit this session and close its pane", "close all": "Quit this base's tower, mains, and members and close it", tower: "Open and focus the workspace tower (tower <prompt> writes to it as the boss, with no focus change)", "tower -w": "Act on another workspace's tower: tower -w <workspace id | label | head> [--answers W3] <message | status | retry | parked | deliver <id> | drop <id> | leave | new>", "tower --answers": "Write to the tower and mark a wait for you answered once it took the message: tower --answers W3 <message>", "tower status": "Show the tower's service, boss conversation, notices, and parked events", "tower parked": "List the events parked after two crashes", "tower retry": "Wake the tower again after a crash loop", "tower leave": "Leave the boss conversation (it ends with a note)", "tower new": "Start over: the next boss conversation is a new session", head: "Open and focus the head tower (head <message> writes to it as the boss, with no focus change)", "head status": "Show the head tower's service and notices", "head retry": "Wake the head tower again after a crash loop", "head parked": "List the events parked after two crashes", "head deliver": "Deliver a parked event again: head deliver <id>", "head drop": "Drop a parked event: head drop <id>", "head --answers": "Write to the head tower and mark a wait for you answered once it took the message: head --answers W3 <message>", "head leave": "Leave the head tower's boss conversation (it ends with a note)", "head new": "Start over: the head tower's next conversation is a new chapter", "head close": "Close the head tower (its conversation and memory are kept)", send: "Write to a session as the boss: send <name|key> [--after] <text> (--after queues it for when the session is idle; quote a name with spaces)", stop: "Press Esc in a session after you confirm, as the page's Stop does: stop <name|key>", answer: "List the dialogs other sessions wait on, or answer one after you confirm: answer <name|key> <choice number | text> | --cancel (never a secret)", gui: "Open the net in the browser", "gui stop": "Close the browser GUI", "gui rotate": "Give the GUI a new address and unpair every phone", "gui remote": "Open the GUI to your phone over Tailscale", "gui remote off": "Close the Tailscale entry", "gui lan": "Open the GUI to your phone on the same Wi-Fi", "gui lan off": "Close the Wi-Fi entry", "gui lan reset": "Make a new Wi-Fi certificate (renew, or unpair every Wi-Fi device)", "gui view": "Show the GUI's default view", ...VIEW_ARGUMENTS, "gui devices": "List the paired phones (id, label, when paired and last seen, Tailscale or Wi-Fi)", "gui unpair all": "Unpair every phone (the address does not change; asks first)", server: "Show the sb server, and start it when it is down", "server stop": "Stop the sb server on purpose", "server restart": "Restart the sb server", "server logs": "Show the last lines of the sb server log (server logs 50: at most 200)", wait: "Pick an open wait card from a list and press it: done, an option, skip, reply, or start entering a secret (wait -w <workspace id | label | head> lists one tower's)", memory: "Show the tower's memory (standing instructions, decisions, waits) and what the tower proposes", "memory confirm": "Confirm a proposal of the tower: memory confirm P1", "memory reject": "Reject a proposal of the tower: memory reject P1", "memory add standing": "Keep a standing instruction in your words", "memory add decision": "Keep a decision in your words", stash: "Put this base away: its tower, mains, and members", "stash --workspace": "Put another base away: stash [name] --workspace <label|id> (asks first)", pop: "Open a stashed base again", dismiss: "Hide every finished subagent (dismiss <name> hides one)", "dismiss all": "Hide every finished subagent", "open base": "Open a new base with one member: open base <dir> [label]", "open member": "Add a member beside this session, or in a tab of its own in <dir>: open member [dir]", "open main": "Open a main in a new tab of this base: open main <dir> [prompt]", link: "Show this device's teams and the join requests waiting", "link status": "Show this device's teams and the join requests waiting", "link decide": "Approve or refuse a join request: link decide <id> approve|refuse", "roles-check": "Check each role's tools: names against this session's tools (roles-check [folder]; default: sb's own roles/)" }).map(([value, description]) => ({ value, label: value, description }));

/** The /boss command. */
export function registerBoss(kit: Kit, { runMode, host, membership, reach, closeSelf, stashing, server, paths }: { runMode?: { active(): boolean; /** `/boss wait` in a tower run's own pane: the one command a run takes (runmode.ts). */ waits?(args: string, ctx: ExtensionContext): Promise<void> }; host: ReturnType<typeof createHost>; membership: Membership; reach: Reach; closeSelf(keepPane: boolean): string | undefined; stashing: ReturnType<typeof createStashing>; server?: ServerLook; paths: ReturnType<typeof createBossPaths> }) {
	const { pi, cfg, s, guiDir, tell } = kit;
	const auto = createBossAuto(kit, server);
	// A boss event sent from here records who sent it (auto mode lists the requester of what it acted on; §2).
	const sender = () => ({ session: kit.me?.(), pane: cfg.env?.HERDR_PANE_ID, pid: process.pid });
	// D15: `/boss tower <prompt>` ensures the tower as a bare `/boss tower` does, then posts the prompt as a `boss` event, the way the GUI's composer does. Nothing is typed anywhere and focus stays.
	const handToTower = async (prompt: string, answers?: string) => {
		if (!server || !towerRunsEnabled(guiDir)) return tell("/boss tower <prompt> needs the tower runs (towerRuns.enabled in the state directory's config.json): the tower is a resident session now, so open it with /boss tower and write to it there.", "warning");
		if (prompt.length > 16_384) return tell("The prompt is longer than 16,384 characters; hand the tower a shorter one and name a file for the rest.", "error");
		await membership.joinNet();
		const tower = await reach.openTower(undefined, true, true);
		const answer = await server.ask({ cmd: "tower-event", workspace: tower.target.workspace_id, text: prompt, present: true, ...sender(), ...(answers ? { answers } : {}) }, { start: "boss" });
		if (!answer.ok) return tell(`The tower did not take the prompt: ${String(answer.error ?? "no answer")}`, "error");
		tell(`Handed to the tower${tower.opened ? " (it was opened for this)" : ""}: it reads the prompt as the boss's instruction in the boss conversation, which stays open while you write (/boss tower leave ends it).${answers ? (answer.answered === answers ? ` ${answers} is marked answered.` : ` ${answers} was not marked answered: the memory no longer has it as a wait for you.`) : ""}`);
	};
	// `/boss memory`: the boss's own interface to the tower's memory (memorycmd.ts); the GUI's panel is the same server op. It is the boss's typed input only: a tower run takes no /boss command.
	const memoryAsk = async (workspace: string, json: Record<string, unknown>) => {
		if (!server) throw new Error("The sb server is not available in this session.");
		const r = await server.ask({ cmd: "tower-memory", workspace, json }, { start: "never" });
		return { ok: r.ok, ...(typeof r.error === "string" ? { error: r.error } : {}), ...(typeof r.status === "number" ? { status: r.status } : {}), ...(typeof r.body === "object" && r.body !== null ? { body: Object.fromEntries(Object.entries(r.body)) } : {}) };
	};
	const memory = (args: string, interactive: boolean) => server
		? runMemoryCommand(args, { lang: memoryLang(cfg.env), interactive, own: s.at?.workspaceId, workspaces: () => workspaces(cfg.run), tell, ask: memoryAsk })
		: Promise.resolve(tell("The sb server is not available in this session.", "warning"));
	// `/boss wait` (waitcmd.ts): the picker of the same presses, over the cards `boss-waits` lists. Its dialogs are terminal-only, under the boss mark and the here mark; an event it sends names this pane as its sender.
	const waitCommand = (args: string, ctx: ExtensionContext) => server
		? runWaitCommand(args, {
			lang: memoryLang(cfg.env), interactive: ctx.hasUI, own: s.at?.workspaceId, tell, memory: memoryAsk, workspaces: () => workspaces(cfg.run), ui: ctx.ui, here: host.here, now: cfg.now,
			ask: async (request) => ({ ...(await server.ask(request.cmd === "tower-event" || request.cmd === "head-event" ? { ...request, ...sender() } : request, { start: "never" })) }),
			tabs: (workspace) => tabs(cfg.run, workspace), focus: async (tab) => void (await cfg.run(["tab", "focus", tab])),
		})
		: Promise.resolve(tell("The sb server is not available in this session.", "warning"));
	// `/boss tower status | retry | parked | deliver <id> | drop <id> | leave | new` (towercmd.ts): the pi twins of the tower card's and composer's buttons, one control command each.
	// `-w <workspace | head>` names another tower (G4): the confirm names it, and the server keeps every check.
	const towerDeps = (server: ServerLook, interactive: boolean): TowerCmdDeps => ({
		lang: memoryLang(cfg.env), interactive, own: s.at?.workspaceId, tell, ask: async (request) => ({ ...(await server.ask(request, { start: "never" })) }),
		workspaces: () => workspaces(cfg.run), confirm: async (title, body) => (await s.ui?.confirm(title, body)) === true,
	});
	const towerCommand = (parsed: NonNullable<ReturnType<typeof parseTowerArgs>>, interactive: boolean, at?: string) => server
		? runTowerCommand(parsed, towerDeps(server, interactive), at)
		: Promise.resolve(tell("The sb server is not available in this session.", "warning"));
	// `/boss tower -w <workspace> <message>`: the boss's words to another tower, with no opening and no focus change.
	const sayAt = async (text: string, at: string, answers: string | undefined, interactive: boolean) => {
		if (!server || !towerRunsEnabled(guiDir)) return tell("/boss tower -w <workspace> <message> needs the tower runs (towerRuns.enabled in the state directory's config.json).", "warning");
		if (text.length > 16_384) return tell("The message is longer than 16,384 characters; hand the tower a shorter one and name a file for the rest.", "error");
		return sayToTower(text, at, answers, towerDeps(server, interactive));
	};
	// `/boss head [status | leave | new | close | <message>]` (headcmd.ts): the pi twins of the head page's composer and buttons, one control command each; a bare one makes the head workspace and focuses its tab.
	const headCommand = (args: string, interactive: boolean) => server
		? runHeadCommand(parseHeadArgs(args), { lang: memoryLang(cfg.env), interactive, tell, ask: async (request, start) => ({ ...(await server.ask(request.cmd === "head-event" ? { ...request, ...sender() } : request, { start })) }), focus: async (tab) => void (await cfg.run(["tab", "focus", tab])) })
		: Promise.resolve(tell("The sb server is not available in this session.", "warning"));
	pi.registerCommand("boss", {
		description: "Take over as this tab's main agent (every session already joins as a member). /boss status shows the coordinators; /boss board shows the work board (every main's line, its done count and age, the stale and the ended ones; this computer only); /boss tower focuses the workspace tower (a main opens it when there is none); /boss tower <prompt> hands the prompt to the tower as the boss, starting or continuing the boss conversation, with no change of focus (/boss tower status, retry, parked, deliver <id>, drop <id>, leave, new; /boss tower -w <workspace id | label | head> acts on, or writes to, another workspace's tower or the head tower after you confirm; /boss tower --answers W<n> <message> marks a wait for you answered once the tower took the message); /boss head [status | retry | parked | deliver <id> | drop <id> | leave | new | close | [--answers W<n>] <message>] is the head tower's own; /boss send <name|key> [--after] <text> writes to another session as the boss and /boss stop <name|key> presses its Esc, after you confirm (quote a name with spaces); /boss answer lists the dialogs other sessions wait on and /boss answer <name|key> [<choice number | text> | --cancel] answers one as the page does, after you confirm (never a secret: that is entered in its terminal); /boss close quits this session and closes its pane (/boss close all: this whole base, its tower, mains, and members); /boss stash [name] puts this base away (tower, mains, members) and /boss pop [name] opens it again; /boss gui opens the net in the browser (/boss gui stop closes it; /boss gui remote opens it to your phone over Tailscale, /boss gui remote off closes that; /boss gui lan opens it to your phone on the same Wi-Fi with a certificate this computer makes, /boss gui lan off closes that, /boss gui lan reset makes a new certificate; /boss gui view <auto|standard|geek|zen|raven> sets the view a device gets when it follows the server, and /boss gui view alone shows it); /boss close <name|key> quits another unit, squad, or base after you confirm (/boss close all <workspace>: that whole base); /boss stash [name] --workspace <label|id> puts another base away; /boss dismiss [all|<name>] hides finished subagents; /boss gui devices lists the paired phones and /boss gui unpair <id|all> unpairs them; /boss server logs [n] shows the server log; /boss server shows the sb server and starts it when it is down (/boss server stop, /boss server restart [reason]); /boss wait lists the wait cards that wait for you (every tower's and the head's, or one with -w) and presses one: done, an option, skip, reply, or the start of a secret; /boss roles-check [folder] checks each role's tools: names against this session's tools (sb's own roles/ by default); /boss memory shows the tower's memory and what it proposes, and confirms or rejects a proposal (/boss memory confirm P1, reject P1), adds, edits, or deletes a standing instruction or decision, and resolves a wait (the GUI mirrors it).",
		// pi passes the whole argument text and replaces it with the chosen value, so each value is a full argument line.
		getArgumentCompletions: (prefix) => {
			const stashed = stashing.names().map((name) => ({ value: `pop ${name}`, label: `pop ${name}`, description: "Open this stashed base again" }));
			const items = [...BOSS_ARGUMENTS, ...LINK_ARGUMENTS, ...stashed].filter((item) => item.value.startsWith(prefix.trimStart()));
			return items.length ? items : null;
		},
		// Under the boss's own mark (autoscope.ts): auto mode answers a dialog opened inside a running tool call as Escape, but never one of these commands' confirms, mid-turn too.
		handler: (args, ctx) => asBoss(async () => {
			s.ui = ctx.ui;
			// A tower run is no part of the net: a bare /boss would promote it to a main in the tower tab.
			// The one command a run takes is `/boss wait` in its own pane (runmode.ts): the boss's keyboard presses a card there, with the run's token never attached.
			if (runMode?.active()) return /^wait(?:\s|$)/.test(args.trim()) && runMode.waits ? await runMode.waits(args.trim().slice(4), ctx) : tell("A tower run takes no /boss command: it is the server's, and it ends with tower_done.", "warning");
			try {
				const line = args.trim(), unpair = /^gui\s+unpair\s+(\S+)$/.exec(line), logs = /^server\s+logs(?:\s+(\S+))?$/.exec(line), sub = /^close\s+all\s+(.+)$/.exec(line), other = /^close\s+(.+)$/.exec(line), dismiss = /^dismiss(?:\s+(.+))?$/.exec(line), open = /^open(?:\s+([\s\S]*))?$/.exec(line), link = /^link(?:\s+([\s\S]*))?$/.exec(line);
				const send = /^send(?=\s|$)([\s\S]*)$/.exec(line), stop = /^stop(?=\s|$)([\s\S]*)$/.exec(line), answer = /^answer(?=\s|$)([\s\S]*)$/.exec(line);
				if (send) return await ((words) => (words ? paths.send(words.query, words.after, words.text) : paths.send("", false, "")))(parseSend(send[1]));
				if (stop) return await paths.stop(parseStop(stop[1]) ?? "");
				if (answer) return await ((a) => paths.answer(a.query, a.cancel, a.text))(parseAnswer(answer[1]));
				const roles = /^roles-check(?:\s+([\s\S]*))?$/.exec(line);
				if (roles) return ((r) => tell(r.text, r.ok ? "info" : "error"))(runRolesCheck(roles[1] ?? "", { tools: () => pi.getAllTools().map((t) => t.name) }));
				const autoLine = /^auto(?:\s+([\s\S]*))?$/.exec(line);
				if (autoLine) return await auto(autoLine[1] ?? "", ctx);
				if (line === "board") return tell(boardCommand({ dir: join(guiDir, "board"), now: cfg.now(), net: await reach.read() }));
				if (/^gui\s+devices$/.test(line)) return await paths.devices();
				if (unpair) return await paths.unpair(unpair[1]!);
				if (logs) return await paths.logs(logs[1]);
				if (sub) return await paths.close(sub[1]!, true);
				if (other && other[1]!.trim() !== "all") return await paths.close(other[1]!);
				if (dismiss) return await paths.dismiss(dismiss[1]);
				if (open) return await paths.open(open[1], ctx.cwd ?? process.cwd());
				if (link) return await paths.link(link[1], ctx.cwd ?? process.cwd());
				if (/^gui( stop| rotate| remote( off)?| lan( off| reset)?| view( \S+)?)?$/.test(args.trim())) return await host.command(args.trim().slice(4));
				const sb = /^server(?:\s+(stop|restart)(?:\s+(.*))?)?$/.exec(args.trim());
				if (sb) return await (server ? server.command((sb[1] ?? "") as "" | "stop" | "restart", sb[2] ?? "", host.here) : tell("The sb server is not available in this session.", "warning"));
				const why = args.trim() === "close" ? (closeSelf(false) ?? "") : undefined;
				if (why !== undefined) return void (why && tell(why, "error"));
				if (args.trim() === "status") return tell(s.joined || s.isTower ? JSON.stringify(await reach.status(), null, 2) : "Not in the net: still joining, or this session cannot join.");
				if (args.trim() === "close all") return await stashing.closeAll();
				const head = /^head(?:\s+([\s\S]*))?$/.exec(args.trim());
				if (head) return await headCommand(head[1] ?? "", ctx.hasUI);
				const wait = /^wait(?:\s+([\s\S]*))?$/.exec(args.trim());
				if (wait) return await waitCommand(wait[1] ?? "", ctx);
				const mem = /^memory(?:\s+([\s\S]*))?$/.exec(args.trim());
				if (mem) return await memory(mem[1] ?? "", ctx.hasUI);
				const flagged = /^stash(?:\s+(.*))?$/.exec(line), flag = flagged && parseStash(flagged[1]);
				if (flag?.flag) return paths.needWorkspace();
				if (flag?.workspace) return await paths.stashOther(flag.name, flag.workspace);
				const stash = /^(stash|pop)(?:\s+(.+))?$/.exec(args.trim());
				if (stash) return await (stash[1] === "stash" ? stashing.stash(stash[2]) : stashing.pop(stash[2]));
				const words = /^tower\s+([\s\S]+)$/.exec(args.trim())?.[1];
				if (words !== undefined) {
					const line = parseTowerLine(words);
					if ("usage" in line) return tell(towerUsage(memoryLang(cfg.env)), "warning");
					// The head's own Herdr workspace, named by id or label, is the head tower, as on the page.
					const at = line.workspace && server ? await headAlias(line.workspace, { workspaces: () => workspaces(cfg.run) }) : line.workspace;
					const found = line.answers ? undefined : parseTowerArgs(line.rest);
					if (found) return await towerCommand(found, ctx.hasUI, at);
					if (at === "head") {
						// The head tower's words are `/boss head`'s: a message that is one of its command words alone is no message here.
						if (parseHeadArgs(line.rest).op !== "say") return tell("Write the message to the head tower with more words (or use /boss head): that one word is a command of its own.", "error");
						return await headCommand(`${line.answers ? `--answers ${line.answers} ` : ""}${line.rest}`, ctx.hasUI);
					}
					if (at) return await sayAt(line.rest, at, line.answers, ctx.hasUI);
					return await handToTower(line.rest, line.answers);
				}
				if (s.isTower) throw new Error("This session is the tower, not a main agent");
				if (args.trim() !== "tower") return tell((await membership.promote(true)).text);
				await membership.joinNet();
				const tower = await reach.openTower(undefined, true, true); // anyone may open the tower by hand; the boss's own command also starts a server that was stopped on purpose
				const where = (await s.c.listSessions()).find((x) => x.id === tower.id)?.herdrLocation;
				if (where?.tab) await cfg.run(["tab", "focus", where.tab.id]);
			} catch (error) {
				tell((error as Error).message, "error");
			}
		}),
	});
}
