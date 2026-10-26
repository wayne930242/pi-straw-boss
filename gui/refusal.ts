import type { SettingsRefusal } from "../src/trust/settings.ts";
import { m } from "./paraglide/messages.js";

// The same cleaning as src/trust/found.ts clean (that module reads files, so the page cannot import it).
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\p{Cf}/gu, "\ufffd");

/** The server's reason, or, when the folder's .pi/settings.json is why (`facts`, src/trust/settings.ts), the same in the page's language. */
export const reasonOf = (reason: string | undefined, facts: unknown) => {
	const r = facts as SettingsRefusal | undefined;
	if (!r) return reason;
	const path = clean(r.path);
	return r.why === "special" ? m.deploy_settings_special({ path })
		: r.why === "large" ? m.deploy_settings_large({ path, limit: String(Math.floor((r.limit ?? 0) / 1024)) })
		: (r.why === "unchecked" ? m.deploy_settings_unchecked : m.deploy_settings_unreadable)({ path, code: r.code ? ` (${r.code})` : "" });
};
