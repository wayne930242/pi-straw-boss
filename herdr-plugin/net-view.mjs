// The Herdr plugin action `net`: toggles the sidebar Agents list into a straw net view and back. The view is one `agent.view.set`
// on Herdr's socket, which the CLI cannot send, sorted by the `sb_order` pane token that pi-straw-boss writes: towers first, then
// each workspace's main agents and members, every subagent right under its launcher, and any agent without the token after them.
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
 * The view params, source aside: a sort by the `sb_order` token, ascending. Herdr sorts a present value before a missing one, so
 * agents the net does not know (no token) stay last in Herdr's own order, and nothing is filtered out.
 */
export const netView = () => ({
	label: "net",
	sort: [{ field: { token: "sb_order" }, order: "asc" }],
});

/**
 * One request on Herdr's socket; resolves with `result`, rejects with an Error whose `code` is Herdr's (or timeout,
 * socket_error, bad_frame, closed). The frame may arrive in pieces, even inside a character.
 * @param {string} socketPath
 * @returns {Call}
 */
export const socketCall = (socketPath) => (method, params) =>
	new Promise((resolve, reject) => {
		const socket = createConnection(socketPath).setTimeout(5000), text = new StringDecoder("utf8");
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

/** Names one run of the Herdr server: the socket file is made anew when a server starts, and a restart drops the view. */
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
 * Flips the net view: off when this plugin's view is on in the running server, otherwise on. A view another owner installed
 * over this one counts as off (clearing by this plugin's source leaves it alone), so one press brings the net view back.
 * @param {{ call: Call, store: Store, source: string, instance: string }} deps
 * @returns {Promise<{ on: boolean }>}
 */
export async function toggle({ call, store, source, instance }) {
	const state = await store.read();
	if (state?.on && state.instance === instance && !(await call("agent.view.clear", { source })).active) {
		await store.write({ on: false, instance });
		return { on: false };
	}
	const view = await call("agent.view.set", { source, ...netView() });
	if (!view.active || view.source !== source) throw new Error(`herdr agent.view.set did not install the view: ${JSON.stringify(view)}`);
	await store.write({ on: true, instance });
	return { on: true };
}

/** Runs the action: HERDR_PLUGIN_ID names the view's owner, so Herdr drops the view when the plugin is unlinked or disabled. */
export async function main(env = process.env) {
	const { HERDR_PLUGIN_ID: id, HERDR_PLUGIN_STATE_DIR: dir, HERDR_SOCKET_PATH: socket } = env;
	if (!id || !dir || !socket) throw new Error("net-view.mjs is a Herdr plugin action: HERDR_PLUGIN_ID, HERDR_PLUGIN_STATE_DIR and HERDR_SOCKET_PATH must be set");
	const result = await toggle({ call: socketCall(socket), store: fileStore(dir), source: `plugin:${id}`, instance: instanceOf(socket) });
	console.log(result.on ? "net view on" : "net view off");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
