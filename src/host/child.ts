// Adapted from pi-herdr-agents f1590cb pi-extension/subagents/child.ts (MIT, Copyright (c) 2026 Giuseppe Rodriguez); see NOTICE.md.
// The entry a child pi loads with `-e`. First, so a reload into another maestro build loads it fresh.
import "./engine-build.ts";
import { createChildExtension } from "@nubl/maestro/pi/child";
import { renderChildWidget } from "./child-widget.ts";

export * from "@nubl/maestro/adapters/pi/child/protocol";
export default createChildExtension(renderChildWidget);
