import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { ENTRY } from "./state.ts";

/** Retire only owned role steers after a full role rebuild; saved history and same-run changes stay. */
export function createRoleContext(pi: ExtensionAPI) {
	let generation: string | undefined;
	// The full-transcript hook preserves Pi's system/tool patches instead of folding them into a new leading prompt and invalidating its cached prefix.
	pi.on("context_with_system", (event) => {
		if (!generation) return;
		const messages = event.messages.filter((m) => {
			if (m.role !== "custom" || m.customType !== ENTRY) return true;
			const details = m.details;
			if (!details || typeof details !== "object" || !("strawBossRoleBrief" in details)) return true;
			const mark = details.strawBossRoleBrief;
			if (!mark || typeof mark !== "object" || !("version" in mark) || mark.version !== 1 || !("generation" in mark) || typeof mark.generation !== "string") return true;
			return mark.generation === generation;
		});
		return messages.length === event.messages.length ? undefined : { messages };
	});
	return {
		begin: (active: boolean) => void (generation = active ? randomUUID() : undefined),
		details: () => ({ strawBossRoleBrief: { version: 1, generation } }),
	};
}
