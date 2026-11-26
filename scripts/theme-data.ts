import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { ManifestMap, ThemeManifest } from "../gui/themes/manifest.ts";
import { VIEWS, MODES } from "../src/views.ts";

/** Source paths are relative to theme.json. The build supplies emitted asset URLs; the dev server serves their source paths. */
export function themeData(root: string, url: (file: string) => string): ManifestMap {
	const map = {} as ManifestMap;
	for (const view of [...VIEWS, ...MODES]) {
		const dir = `themes/${view}`, data: ThemeManifest = JSON.parse(readFileSync(join(root, dir, "theme.json"), "utf8"));
		for (const clip of Object.values(data.ambience ?? {})) clip.file = url(posix.join(dir, clip.file));
		for (const key of Object.keys(data.sounds ?? {}) as (keyof NonNullable<ThemeManifest["sounds"]>)[]) data.sounds![key] = url(posix.join(dir, data.sounds![key]!));
		map[view] = data;
	}
	return map;
}
export function metaTag(map: object) {
	const attr = JSON.stringify(map).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
	return `<meta name="sb-themes" content="${attr}">`;
}
