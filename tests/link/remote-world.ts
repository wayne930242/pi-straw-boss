import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shortId } from "../../src/link/device.ts";
import type { PolicyDeps } from "../../src/link/policy.ts";
import type { Link } from "../../src/link/runtime.ts";
import { LinkStore } from "../../src/link/store.ts";
import { MESSAGE_TYPE } from "../../src/link/turn.ts";
import { type Agent, World } from "../fakes.ts";
import type { FakeRelay } from "./fake-relay.ts";
import { alice, bob, carol, clientFor, rosterOf, TEAM_HEX, writeDevice, writeTeam } from "./holder-world.ts";
import { TEAM } from "./scenario.ts";

// A computer with a tower that has a team, a project that is a git repository, and trust levels, for the remote-turn tests: events are fired at the
// tower the way pi fires them (message_start of a straw-link custom message, tool_call, agent_settled).

export { alice, bob, carol, TEAM_HEX };
export const FAST = { tickMs: 15, drainMs: 20, presenceMs: 40, pumpMs: 10, boardMs: 150, offerAgainMs: 60_000 };

export interface Computer {
	/** The dependencies a session on this computer takes (the link seams), so a main or member started here shares the same relay and home. */
	deps: { link: Record<string, unknown> };
	world: World;
	tower: Agent;
	link: Link;
	project: string;
	home: string;
	dir: string;
}

/** `root` is a scratch folder; `who` picks which device's keys this computer has; `trust` is config.json's link.trust. */
export function computer(root: string, relay: FakeRelay, who: "a" | "b", o: { trust?: Record<string, string>; ui?: boolean; gateMs?: number; terminalMs?: number; members?: ("bob" | "carol")[]; policy?: PolicyDeps; url?: string; client?: ReturnType<typeof clientFor> } = {}): Computer {
	const world = new World();
	const keys = who === "a" ? alice : bob, home = join(root, `home-${who}`), raw = join(root, `project-${who}`);
	mkdirSync(raw, { recursive: true });
	const project = realpathSync(raw);
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", project, ...args], { stdio: "ignore" });
	git("init", "-q");
	writeFileSync(join(project, "a.ts"), "export const a = 1;\n");
	writeFileSync(join(project, "secret.txt"), "untracked\n");
	git("add", "a.ts");
	git("commit", "-q", "-m", "init");
	const entries = rosterOf(o.members ?? ["bob"]);
	const store = new LinkStore(join(world.stateDir, "link"));
	writeDevice(store, keys, who === "a" ? "alice-mac" : "bob-mac");
	writeTeam(store, entries, keys, o.url ? { relay: o.url } : {});
	writeFileSync(join(world.stateDir, "config.json"), JSON.stringify({ link: { relay: o.url ?? "http://relay.test", teams: { [TEAM_HEX]: { project, share: "status" } }, trust: o.trust ?? {} } }));
	relay.addTeam(TEAM, [alice.id, bob.id], entries);
	let link: Link | undefined;
	const deps = { link: { ...FAST, home, gateMs: o.gateMs, requestMs: o.gateMs, terminalMs: o.terminalMs, relay: o.client ?? clientFor(relay), alive: (r: { session: string }) => !world.gone.has(r.session), created: (l: Link) => void (link = l), policy: o.policy ?? { read: () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); } } } };
	const tower = world.tower(`tower-${who}`, "wA:t7", "wA:p7", o.ui ?? false, deps);
	world.herdr.pane("wA:p7").cwd = project;
	tower.cwd = project;
	return { world, tower, deps, get link() { return link!; }, project, home, dir: store.dir };
}

let counter = 0;
/** The custom message pi enters into a run for a delivery from `from`: what `pump` sends with triggerTurn. */
export function remoteMessage(from: { id: string }, label = "bob-mac", id = (++counter).toString(16).padStart(32, "0")) {
	return { role: "custom", customType: MESSAGE_TYPE, content: `[straw net …] hello ${id}`, display: true, details: { id, team: TEAM_HEX, from: from.id, label, short: shortId(from.id), seq: counter, sentAt: 1 }, timestamp: 1 };
}
export const localMessage = (text = "do the thing") => ({ role: "user", content: text, timestamp: 1 });
