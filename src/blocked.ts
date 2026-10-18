import type { ExtensionAPI, UIPromptEndEvent, UIPromptStartEvent } from "@earendil-works/pi-coding-agent";

// rpiv-ask-user-question reports its wait as `rpiv:ask-user:blocked`, while Herdr's pi integration and the GUI listen for
// `herdr:blocked`. This relays one into the other, once per open questionnaire, so a session waiting on it shows as blocked.
// Pi's own `ui_prompt_start` / `ui_prompt_end` (one pair per outermost ctx.ui dialog, whichever extension opened it) get the same
// treatment for select, confirm, input and editor; `custom` stays out, as pi itself does not count it as blocking and the custom dialogs that do block signal it.
// Every pi does this, joined or not, subagents included.

export const RPIV_BLOCKED = "rpiv:ask-user:blocked";
const LABEL = "Waiting for an answer to ask_user_question";
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);
// The title is extension-supplied text for the sidebar: control and format characters become spaces, and it is cut to 80 characters.
const labelOf = ({ kind, title }: UIPromptStartEvent | UIPromptEndEvent) => {
	const text = [...String(title ?? "").replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()];
	const shown = text.slice(0, 80).join("") + (text.length > 80 ? "…" : "");
	return `Waiting for your answer: ${shown || `${kind} dialog`}`;
};

export default function blockedRelay(pi: ExtensionAPI): void {
	const open = new Set<string>();
	pi.events.on(RPIV_BLOCKED, (data) => {
		const { active, toolCallId } = (data ?? {}) as { active?: unknown; toolCallId?: unknown };
		if (typeof toolCallId !== "string" || typeof active !== "boolean" || open.has(toolCallId) === active) return;
		if (active) open.add(toolCallId);
		else open.delete(toolCallId);
		pi.events.emit("herdr:blocked", active ? { active, label: LABEL } : { active });
	});

	// Pi emits both events unawaited and walks the extensions one after another, so behind a slow earlier handler this one can see a dialog's end before its start:
	// the count may dip below zero and comes back, and blocked is reported only while it is above zero, so the pairs stay balanced in any arrival order.
	let depth = 0;
	const dialog = (by: 1 | -1) => (event: UIPromptStartEvent | UIPromptEndEvent) => {
		if (!DIALOGS.has(event.kind)) return;
		const was = depth > 0;
		depth += by;
		if (was === depth > 0) return;
		// An end that arrives after a reload or new session retired this runtime cannot be relayed; that runtime has no dialog left to report.
		try { pi.events.emit("herdr:blocked", depth > 0 ? { active: true, label: labelOf(event) } : { active: false }); } catch {}
	};
	pi.on("ui_prompt_start", dialog(1));
	pi.on("ui_prompt_end", dialog(-1));
}
