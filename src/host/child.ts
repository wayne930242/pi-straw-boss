// Adapted from pi-herdr-agents f1590cb pi-extension/subagents/child.ts (MIT, Copyright (c) 2026 Giuseppe Rodriguez); see NOTICE.md.
// The entry a child pi loads with `-e`. First, so a reload into another maestro build loads it fresh.
import "./engine-build.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChildExtension } from "@nubl/maestro/pi/child";
import { renderChildWidget } from "./child-widget.ts";
import { nudgeInbox } from "./nudge-child.ts";

export * from "@nubl/maestro/adapters/pi/child/protocol";

const maestroChild = createChildExtension(renderChildWidget);

/** Maestro's child protocol, and the inbox of sb's done nudge (nudge-child.ts). */
export default function sbChild(pi: ExtensionAPI): void {
	maestroChild(pi);
	nudgeInbox(pi);
}
