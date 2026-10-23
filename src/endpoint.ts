import { homedir, tmpdir } from "node:os";
import { posix, win32 } from "node:path";

// Where a local socket is on each platform: Herdr's, found as Herdr finds it, and the endpoint a client connects to for a socket path.

/**
 * The socket of the Herdr server a process runs under, resolved as Herdr resolves it: `HERDR_SOCKET_PATH`, else `HERDR_SESSION`'s socket, else the default
 * one in Herdr's config directory (`XDG_CONFIG_HOME`, else `%APPDATA%` on Windows and `~/.config` elsewhere). Two sessions are on the same Herdr when this is the same text.
 */
export function herdrSocket(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
	if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
	const path = platform === "win32" ? win32 : posix, home = env.HOME || homedir();
	const config = env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, "herdr")
		: platform !== "win32" ? path.join(home, ".config", "herdr")
		: env.APPDATA ? path.join(env.APPDATA, "herdr") : env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Roaming", "herdr") : env.HOME ? path.join(env.HOME, ".config", "herdr") : path.join(tmpdir(), "herdr");
	// Herdr ignores a session name it would reject (and `default`, the default session).
	const session = env.HERDR_SESSION && env.HERDR_SESSION !== "default" && /^[A-Za-z0-9._-]{1,64}$/.test(env.HERDR_SESSION) && ![".", ".."].includes(env.HERDR_SESSION) ? env.HERDR_SESSION : undefined;
	return session ? path.join(config, "sessions", session, "herdr.sock") : path.join(config, "herdr.sock");
}
/**
 * Where a client connects for Herdr's socket path. On Windows the path is a marker file, and Herdr listens on the named pipe `\\.\pipe\` + that path
 * (a sidecar's pipe is a full pipe name already, and does not go through here). Elsewhere it is the Unix socket at the path.
 */
export const localEndpoint = (socketPath: string, platform: NodeJS.Platform = process.platform) => (platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath);
