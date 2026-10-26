import type { SettingsRefusal } from "../src/trust/settings.ts";
import { m } from "./paraglide/messages.js";

/** The server's reason, or, when the folder's .pi/settings.json is why (`facts`, src/trust/settings.ts), the same in the page's language. */
export const reasonOf = (reason: string | undefined, facts: unknown) => {
	const r = facts as SettingsRefusal | undefined;
	if (!r) return reason;
	const path = r.target ? `${r.path} → ${r.target}` : r.path;
	return r.why === "special" ? m.deploy_settings_special({ path })
		: r.why === "large" ? m.deploy_settings_large({ path, size: String(Math.ceil((r.size ?? 0) / 1024)), limit: String(Math.floor((r.limit ?? 0) / 1024)) })
		: m.deploy_settings_unreadable({ path, code: r.code ? ` (${r.code})` : "" });
};
