import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GuiLink } from "../src/link/guiport.ts";
import type { Run } from "../src/remote.ts";

// What the tests give the sb server's GUI in place of the machine's: a page bundle, a link holder that is not there, and a Tailscale (absent, or a fake that serves).

export const scratch = mkdtempSync(join(tmpdir(), "psb-gui-world-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
export const bundle = join(scratch, "bundle");
mkdirSync(bundle, { recursive: true });
writeFileSync(join(bundle, "index.html"), "<title>Straw Net</title>");

/** The link holder is not under test here: the GUI's way to it answers that none runs. */
export const noLink: GuiLink = { call: async () => ({ ok: false, error: "No link holder is running on this computer yet.", code: "no_holder" }), enable: async () => {}, summary: async () => undefined, close() {} };
/** A Tailscale that is not installed. */
export const noTailscale: Run = async () => { throw new Error("Tailscale is not installed (no tailscale command on PATH)"); };
/** A fake tailscale: this machine is box on the tailnet, and serve keeps one background config. */
export function fakeTailscale(login = "me@example.com") {
	let config: Record<string, unknown> = {};
	const calls: string[][] = [];
	const run: Run = async (args) => {
		calls.push(args);
		if (args[0] === "status") return JSON.stringify({ BackendState: "Running", Self: { DNSName: "box.tail1.ts.net.", UserID: 7 }, User: { "7": { LoginName: login } } });
		if (args.join(" ") === "serve status --json") return JSON.stringify(config);
		if (args[1] === "--bg") config = { TCP: { "8443": { HTTPS: true } }, Web: { "box.tail1.ts.net:8443": { Handlers: { "/": { Proxy: args[3] } } } } };
		if (args.join(" ") === "serve --https=8443 off") config = {};
		return "";
	};
	return { run, config: () => config, calls };
}

