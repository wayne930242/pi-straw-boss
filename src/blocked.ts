import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// rpiv-ask-user-question reports its wait as `rpiv:ask-user:blocked`, while Herdr's pi integration and the GUI listen for
// `herdr:blocked`. This relays one into the other, once per open questionnaire, so a session waiting on it shows as blocked.
// Every pi does this, joined or not, subagents included.

export const RPIV_BLOCKED = "rpiv:ask-user:blocked";
const LABEL = "Waiting for an answer to ask_user_question";

export default function blockedRelay(pi: ExtensionAPI): void {
	const open = new Set<string>();
	pi.events.on(RPIV_BLOCKED, (data) => {
		const { active, toolCallId } = (data ?? {}) as { active?: unknown; toolCallId?: unknown };
		if (typeof toolCallId !== "string" || typeof active !== "boolean" || open.has(toolCallId) === active) return;
		if (active) open.add(toolCallId);
		else open.delete(toolCallId);
		pi.events.emit("herdr:blocked", active ? { active, label: LABEL } : { active });
	});
}
