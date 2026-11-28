import { keyText, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text, TruncatedText } from "@earendil-works/pi-tui";

/** Only role steers fold. Tower digests share the custom type and keep pi's normal view. */
export const roleView: MessageRenderer<{ briefed?: { name?: string; duty?: string } }> = (msg, options, theme) => {
	const { expanded, outputPad } = options, role = msg.details?.briefed;
	if (!role || typeof msg.content !== "string") return undefined;
	if (expanded) return new Text(msg.content, outputPad, 0);
	const keys = (options as typeof options & { keyText?: typeof keyText }).keyText ?? keyText;
	const key = keys("app.tools.expand"), lines = msg.content.split("\n").length;
	const title = `[straw-boss] role: ${role.name ?? "none"}${role.duty ? ` · ${role.duty}` : ""}`;
	return new TruncatedText(theme.fg("customMessageLabel", title) + theme.fg("dim", ` (${lines} lines${key ? `, ${key} to expand` : ""})`), outputPad, 0);
};
