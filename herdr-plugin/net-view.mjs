// The Herdr plugin action `net`: toggles the sidebar Agents list into a straw net view and back. The view is one `agent.view.set`
// on Herdr's socket, which the CLI cannot send, sorted by the `sb_order` pane token that pi-straw-boss writes: towers first, then
// each workspace's main agents and members, every subagent right under its launcher, and any agent without the token after them.
// `net-view.mjs startup`, the plugin's startup hook, turns the view on once when a Herdr server starts and exits. `net-view.mjs reapply`, the plugin's
// event hook (a pane's agent detected), puts the view back when the plugin was unlinked and linked again inside one server run, which drops the view and runs no startup hook.
// Plain JavaScript with no imports from the extension, so the folder works wherever Herdr links or installs it.
import { statSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

/** @typedef {(method: string, params: Record<string, unknown>) => Promise<any>} Call */
/** @typedef {{ on: boolean, instance: string }} State */
/** @typedef {{ read(): Promise<State | undefined>, write(state: State): Promise<void> }} Store */

/**
 * The view params, source aside: a sort by the `sb_order` token, ascending, then by Herdr's workspace, tab and pane order. Herdr sorts a
 * present value before a missing one, so agents the net does not know (no token) come last, in the place order of the second sort
 * instead of whatever order Herdr happened to list them in, and nothing is filtered out.
 */
export const netView = () => ({
	label: "net",
	sort: [{ field: { token: "sb_order" }, order: "asc" }, ...["workspace_order", "tab_order", "pane_order"].map((field) => ({ field, order: "asc" }))],
});

/**
 * Where to connect for Herdr's socket path: on Windows the path is a marker file and Herdr listens on the named pipe `\\.\pipe\` + that path,
 * elsewhere it is the Unix socket itself (the extension's `localEndpoint`, kept here because this folder imports nothing from it).
 * @param {string} socketPath
 */
export const localEndpoint = (socketPath, platform = process.platform) => (platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath);

/**
 * One request on Herdr's socket; resolves with `result`, rejects with an Error whose `code` is Herdr's (or timeout,
 * socket_error, bad_frame, closed). The frame may arrive in pieces, even inside a character.
 * @param {string} socketPath
 * @returns {Call}
 */
export const socketCall = (socketPath) => (method, params) =>
	new Promise((resolve, reject) => {
		const socket = createConnection(localEndpoint(socketPath)).setTimeout(5000), text = new StringDecoder("utf8");
		let reply = "";
		const fail = (code, message) => {
			socket.destroy();
			reject(Object.assign(new Error(`herdr ${method} failed: ${code} ${message}`.trim()), { code }));
		};
		socket.on("connect", () => socket.write(`${JSON.stringify({ id: `straw-boss-net-${Date.now()}`, method, params })}\n`));
		socket.on("data", (chunk) => {
			reply += text.write(chunk);
			if (!reply.includes("\n")) return;
			socket.destroy();
			try {
				const { result, error } = JSON.parse(reply.split("\n")[0]);
				if (error) fail(error.code ?? "herdr_error", error.message ?? "");
				else resolve(result);
			} catch {
				fail("bad_frame", reply.slice(0, 200));
			}
		});
		socket.on("timeout", () => fail("timeout", "no answer within 5000 ms"));
		socket.on("error", (error) => fail("socket_error", error.message));
		socket.on("close", () => fail("closed", "the connection closed before an answer"));
	});

/** Names one run of the Herdr server: the socket file (on Windows its marker file) is made anew when a server starts, and a restart drops the view. */
export const instanceOf = (socketPath) => {
	const { ino, birthtimeMs } = statSync(socketPath);
	return `${ino}:${birthtimeMs}`;
};

/**
 * Remembers whether this plugin turned the view on, in a file under the plugin's state directory.
 * A missing or unreadable file reads as off: turning on again just replaces this plugin's own view.
 * @returns {Store}
 */
export const fileStore = (dir) => ({
	async read() {
		try {
			return JSON.parse(await readFile(join(dir, "net-view.json"), "utf8"));
		} catch {
			return undefined;
		}
	},
	async write(state) {
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "net-view.json"), `${JSON.stringify(state)}\n`);
	},
});

/**
 * What Herdr's active Agents view is now, without changing it. Herdr has no query for it, but `agent.view.clear` with a source that owns nothing
 * "leaves the active view unchanged" and answers with it (checked on Herdr 0.9.5, with a plugin's source and with sources of no plugin: `active`, `source`,
 * `label`; clearing the view's own source answers inactive whether or not it was there, which is why the saved state could not be trusted). That is why the
 * plugin needs Herdr 0.9.5. The probe's source is outside the `plugin:` namespace and unique to each probe, so it can never be the source of a view someone
 * owns (a plugin whose id is `<this id>-probe` owns `plugin:<this id>-probe`).
 * @param {{ call: Call, source: string }} deps
 * @returns {Promise<{ active: boolean, source?: string }>}
 */
export const activeView = async ({ call, source }) => {
	const probe = `straw-boss-probe:${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const view = await call("agent.view.clear", { source: probe });
	return { active: Boolean(view.active), source: view.source };
};

/**
 * Installs the net view as `source` and records it as on. A view that was installed but whose state cannot be saved is cleared again:
 * without the state a later press would install the view again and never clear it.
 * @param {{ call: Call, store: Store, source: string, instance: string }} deps
 * @returns {Promise<{ on: true }>}
 */
async function install({ call, store, source, instance }) {
	const view = await call("agent.view.set", { source, ...netView() });
	try {
		if (!view.active || view.source !== source) throw new Error(`herdr agent.view.set did not install the view: ${JSON.stringify(view)}`);
		await store.write({ on: true, instance });
	} catch (error) {
		await call("agent.view.clear", { source }).catch(() => {});
		throw error;
	}
	return { on: true };
}

/**
 * Flips the net view by what Herdr shows now, not by what was saved: off when this plugin's view is the active one, otherwise on, so one press always
 * changes what the sidebar shows. A saved "on" can be wrong after the plugin was unlinked and linked again, or disabled and enabled, in one server run
 * (Herdr drops the view and runs no startup hook), and the first press then only recorded "off". A view another owner installed over this one counts
 * as off (clearing by this plugin's source leaves it alone), so one press brings the net view back. The state file keeps only the wish (on or off) for
 * the startup and reapply hooks.
 * @param {{ call: Call, store: Store, source: string, instance: string }} deps
 * @returns {Promise<{ on: boolean }>}
 */
export async function toggle(deps) {
	const { call, store, source, instance } = deps;
	const now = await activeView(deps);
	if (now.active && now.source === source) {
		// The wish is written first: an event hook that sees the view gone must also see the off, and a wish that cannot be written clears nothing (the view stays and the press says why).
		const before = await store.read();
		await store.write({ on: false, instance });
		try {
			if ((await call("agent.view.clear", { source })).active) throw new Error("herdr agent.view.clear did not clear the view");
		} catch (error) {
			// The view is still there: the wish goes back to what it was, so the next agent's reapply and the next press agree with what shows.
			await store.write(before ?? { on: true, instance }).catch(() => {});
			throw error;
		}
		return { on: false };
	}
	return install(deps);
}

/**
 * The reapply rule, for an event in a server that is already running: the net view is on by default and by the saved wish, so when nothing shows it
 * (the plugin was linked again, or enabled again, and Herdr dropped the view), it is installed. This server's own "off" stands, and any active view
 * stays: this plugin's own, or another owner's, which only a startup or a press replaces.
 * @param {{ call: Call, store: Store, source: string, instance: string }} deps
 * @returns {Promise<{ on: boolean }>}
 */
export async function reapply(deps) {
	const state = await deps.store.read();
	if (state?.on === false && state.instance === deps.instance) return { on: false };
	const now = await activeView(deps);
	if (now.active) return { on: now.source === deps.source };
	// A press may have cleared the view between the first read and the probe: it wrote its off before it cleared, so the wish is read again before anything is installed.
	const again = await deps.store.read();
	if (again?.on === false && again.instance === deps.instance) return { on: false };
	return install(deps);
}

/**
 * The startup rule: the net view is on by default, so a server that has just started gets it. Herdr drops the view when a server ends and a
 * new server has another identity, so whatever an earlier one left counts for nothing. The one state it keeps is this server's own "off":
 * a hook that runs again in the same server (a handoff that keeps the socket) does not undo a press that turned the view off.
 * @param {{ call: Call, store: Store, source: string, instance: string }} deps
 * @returns {Promise<{ on: boolean }>}
 */
export async function startup(deps) {
	const state = await deps.store.read();
	return state?.on === false && state.instance === deps.instance ? { on: false } : install(deps);
}

/**
 * Runs the action, or with `startup` the startup hook: HERDR_PLUGIN_ID names the view's owner, so Herdr drops the view when the plugin is
 * unlinked or disabled. Both are one-shot: the process exits once the view is set, and nothing stays running.
 * @param {Record<string, string | undefined>} env
 * @param {string[]} args
 */
export async function main(env = process.env, args = process.argv.slice(2)) {
	const { HERDR_PLUGIN_ID: id, HERDR_PLUGIN_STATE_DIR: dir, HERDR_SOCKET_PATH: socket } = env;
	if (!id || !dir || !socket) throw new Error("net-view.mjs is a Herdr plugin action: HERDR_PLUGIN_ID, HERDR_PLUGIN_STATE_DIR and HERDR_SOCKET_PATH must be set");
	if (args.length > 1 || (args.length === 1 && args[0] !== "startup" && args[0] !== "reapply")) throw new Error(`net-view.mjs takes no argument (the action), "startup" or "reapply" (the hooks), not: ${args.join(" ")}`);
	const result = await ({ startup, reapply }[args[0]] ?? toggle)({ call: socketCall(socket), store: fileStore(dir), source: `plugin:${id}`, instance: instanceOf(socket) });
	console.log(result.on ? "net view on" : "net view off");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
