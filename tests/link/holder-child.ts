import { createInterface } from "node:readline";
import { startOf } from "../../src/startof.ts";
import { LinkElection } from "../../src/link/election.ts";
import { LinkHolder } from "../../src/link/holder.ts";
import { RelayClient } from "../../src/link/relay.ts";
import { LinkStore, type InboxItem } from "../../src/link/store.ts";
import { netOf, TEAM_HEX } from "./holder-world.ts";

// A pi-like link-holder process for the live test: the election and the holder of src/link/, a LinkStore on a directory, the real relay client, and a
// stand-in for the tower (it prints what it is offered). Commands on stdin: `send <device> <text>` and `quit`. Everything it does is one JSON line on
// stdout. MODE=crash-before-put kills the process at the first inbox write; MODE=hold-ack never sends an acknowledgement.
//   node holder-child.ts <dir> <relay url> <project> <name> [tower]

const [dir, url, project, name, tower] = process.argv.slice(2) as [string, string, string, string, string | undefined];
const mode = process.env.MODE ?? "none";
const say = (event: Record<string, unknown>) => console.log(JSON.stringify({ name, ...event }));

class ChildStore extends LinkStore {
	override putInbox(item: InboxItem): void {
		if (mode === "crash-before-put") {
			say({ ev: "crashing", id: item.id });
			process.kill(process.pid, "SIGKILL");
		}
		super.putInbox(item);
		say({ ev: "put", id: item.id, text: item.text });
	}
}
class ChildClient extends RelayClient {
	override async ack(team: Uint8Array, ids: Uint8Array[], signal?: AbortSignal): Promise<number> {
		if (mode === "hold-ack") {
			say({ ev: "ack-held", ids: ids.length });
			return new Promise<number>(() => undefined);
		}
		return super.ack(team, ids, signal);
	}
}

const store = new ChildStore(dir);
const net = tower ? netOf([[`tower-${name}`, `w-${name}`, `label-${name}`, project]]) : netOf([]);
let holder: LinkHolder | undefined;
const election = new LinkElection({
	store,
	self: () => ({ session: name, version: "0.43.0", tower: Boolean(tower), pid: process.pid, started: startOf(process.pid) }),
	onGain: async () => {
		const device = store.device()!;
		holder = new LinkHolder({
			store, isHolder: () => election.isHolder(), net: async () => net, notify: (text) => say({ ev: "notice", text }), drainMs: 100, presenceMs: 60_000, backoff: () => 50,
			config: () => ({ teams: new Map([[TEAM_HEX, { project, share: "presence" as const, name: "live" }]]), trust: new Map(), problems: [] }),
			relay: (relayUrl, keys) => new ChildClient({ url: relayUrl, device: keys }),
			offer: (session, id) => {
				const item = store.readInbox(id);
				say({ ev: "offer", id, tower: session.id, text: item?.text, from: item?.fromLabel });
				void holder?.taken(id, session.id);
			},
		});
		void device;
		await holder.start();
		say({ ev: "gain" });
	},
	onLose: async () => {
		await holder?.stop();
		holder = undefined;
		say({ ev: "lose" });
	},
});

setInterval(() => void election.tick().catch((error: Error) => say({ ev: "tick-failed", error: error.message })), 100);
say({ ev: "ready", pid: process.pid });

createInterface({ input: process.stdin }).on("line", (line) => {
	const [cmd, device, ...rest] = line.split(" ");
	if (cmd === "quit") void election.release().then(() => process.exit(0));
	if (cmd === "send" && holder) void holder.send({ fromSession: `tower-${name}`, device: device!, text: rest.join(" "), reply: false }).then((r) => say({ ev: "sent", ...r }));
});
