import { rmSync } from "node:fs";
import { join } from "node:path";
import { readOwnedText, writeJson } from "./record.ts";

// The GUI listener's token and CSRF secret outlive the listener (docs/specs/2026-10-26-sb-backend.md, D27): a restart, an upgrade, a crash, or a reboot binds the same ports again under the same address, so an open
// page and an installed phone app keep working. They are kept in `gui-secrets.json` beside paired.json, written the same way (a new temporary file, mode 600, renamed into place; on Windows the state folder's ACL).
// The file also names the two ports: the token belongs to that pair of ports, and a listener that cannot get both back is a new listener with a new token (a holder kept a port; RC3-F002's concern, kept for that case).

export const SECRETS_FILE = "gui-secrets.json";
export interface GuiSecrets { token: string; csrf: string; port: number; remotePort: number }
/** Why a start has no secrets to keep: nothing was stored, the file is not one this code wrote, or the boss rotated on purpose (the file is removed then, so that reads as missing). */
export type Lost = "missing" | "corrupt";

const HEX = /^[0-9a-f]{32}$/;
const port = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v < 65536;

/** The stored secrets, or why there are none. A file another account owns, a link, or text that is not exactly what `keepSecrets` writes is corrupt. */
export function readSecrets(dir: string): { secrets: GuiSecrets } | { lost: Lost } {
	const text = readOwnedText(join(dir, SECRETS_FILE));
	if (text === undefined) return { lost: "missing" };
	try {
		const v = JSON.parse(text) as Record<string, unknown>;
		if (v && typeof v === "object" && v.v === 1 && typeof v.token === "string" && HEX.test(v.token) && typeof v.csrf === "string" && HEX.test(v.csrf) && port(v.port) && port(v.remotePort) && v.token !== v.csrf) {
			return { secrets: { token: v.token, csrf: v.csrf, port: v.port, remotePort: v.remotePort } };
		}
	} catch {} // corrupt
	return { lost: "corrupt" };
}

/** Writes the secrets; throws when the folder cannot be written (the caller says so: the listener runs, and the next start has a new token). */
export const keepSecrets = (dir: string, secrets: GuiSecrets) => writeJson(join(dir, SECRETS_FILE), { v: 1, ...secrets });

/** Removes the stored secrets: the next listener to start draws new ones. Throws when the file cannot be removed, since a file left behind would bring the old address back. */
export const dropSecrets = (dir: string) => rmSync(join(dir, SECRETS_FILE), { force: true });
