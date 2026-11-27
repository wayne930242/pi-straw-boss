// Adapted from pi-herdr-agents f1590cb pi-extension/subagents/index.ts (MIT, Copyright (c) 2026 Giuseppe Rodriguez); see NOTICE.md.
// First, so a reload into another maestro build loads it fresh.
import "./engine-build.ts";
import { fileURLToPath } from "node:url";
import { createPiExtension, maestroBuildInfo } from "@nubl/maestro/pi";
import { hostSurfaceBinding } from "./host-surface.ts";
import { borderLine, createWidgetController } from "./widgets.ts";
import { registerMessageRenderers } from "./renderers.ts";
import { toolRenderers } from "./tool-renderers.ts";
import { stampedLoad, stampedOnFailure, type StampSources } from "./load-stamp.ts";

/** The sb package root: the host stamps it as the wrapper, the way pi-herdr-agents stamps its own. */
const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");

const stampSources: StampSources = { root, maestro: maestroBuildInfo };

/** The child entry every launch passes with `-e`; its path stays fixed across sb releases. */
export const childEntryPath = fileURLToPath(new URL("./child.ts", import.meta.url));

// Invoked per load, not in the engine cache. Presentation never replaces a run owner.
const extension = stampedOnFailure(
  () =>
    createPiExtension({
      hostSurface: hostSurfaceBinding,
      presentation: { borderLine, createWidgets: createWidgetController, registerMessageRenderers, toolRenderers },
      childEntryPath,
      configAssetRoot: root,
    }),
  stampSources,
);

export default function sbHost(...args: Parameters<typeof extension>): ReturnType<typeof extension> {
  return stampedLoad(() => extension(...args), stampSources);
}
