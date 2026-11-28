// Adapted from pi-herdr-agents f1590cb pi-extension/subagents/index.ts, with the run rows of 2045e55 (MIT, Copyright (c) 2026 Giuseppe Rodriguez); see NOTICE.md.
// First, so a reload into another maestro build loads it fresh.
import "./engine-build.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createPiExtension, maestroBuildInfo } from "@nubl/maestro/pi";
import { loadAgentDefaults, resolveEffectivePersistent } from "@nubl/maestro/pi/subagents/catalog";
import { hostSurfaceBinding } from "./host-surface.ts";
import { borderLine, createWidgetController } from "./widgets.ts";
import { RunRows } from "./run-rows.ts";
import { registerMessageRenderers } from "./renderers.ts";
import { toolRenderers } from "./tool-renderers.ts";
import { stampedLoad, stampedOnFailure, type StampSources } from "./load-stamp.ts";
import { simpleApi } from "./surface.ts";
import { createNudger, readNudgeSettings } from "./nudge.ts";
import { localeOf } from "../locale.ts";

/** The sb package root: the host stamps it as the wrapper, the way pi-herdr-agents stamps its own. */
export const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");

const stampSources: StampSources = { root, maestro: maestroBuildInfo };

/** The child entry every launch passes with `-e`; its path stays fixed across sb releases. */
export const childEntryPath = fileURLToPath(new URL("./child.ts", import.meta.url));

// The run-rows presenter of each API the engine registered through: the widget finds it by walking the live API's prototype chain (Maestro's deferred
// and error-encoding APIs inherit from the one it was given), and a todo panel's claim on that presenter hides its rows from the Subagents box.
const presenters = new WeakMap<ExtensionAPI, RunRows>();
let registerRows: (pi: ExtensionAPI) => void = () => {};

// Invoked per load, not in the engine cache. Presentation never replaces a run owner.
const extension = stampedOnFailure(
	() =>
		createPiExtension({
			hostSurface: hostSurfaceBinding,
			presentation: {
				borderLine,
				createWidgets: (deps) => {
					registerRows = (pi) => {
						const rows = new RunRows();
						presenters.set(pi, rows);
						rows.register(pi, deps.runtime.runningSubagents);
					};
					// sb's state folder, as the host entry reads it (index.ts): the done nudge's settings and the notice's language.
					const stateDir = join(getAgentDir(), "straw-boss");
					const nudger = createNudger({ settings: () => readNudgeSettings(stateDir), locale: () => localeOf(process.env, stateDir) });
					return createWidgetController(deps, presenters, nudger);
				},
				registerMessageRenderers,
				toolRenderers,
			},
			childEntryPath,
			configAssetRoot: root,
		}),
	stampSources,
);

export const __test__ = extension.__test__;

/** Loads Maestro through the simple surface (surface.ts) on `pi`, which is the late API of the host entry. */
export default function sbHost(pi: ExtensionAPI): void {
	const api = simpleApi(pi, {
		persistentRole: (agent, params) => {
			const defs = loadAgentDefaults(agent, pi);
			return Boolean(defs && resolveEffectivePersistent(params as never, defs));
		},
	});
	stampedLoad(() => {
		extension(api);
		registerRows(api);
	}, stampSources);
}
