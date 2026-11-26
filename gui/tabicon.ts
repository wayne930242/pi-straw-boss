import type { Face } from "../src/views.ts";
import type { Phase } from "./phase.ts";
import type { Badge, ManifestMap } from "./themes/manifest.ts";

/** The tab icon as the page's own SVG text: the link's data URL decoded, or the built file's URL fetched. */
export async function plainOf(href: string, get: (url: string) => Promise<{ text(): Promise<string> }> = fetch): Promise<string | undefined> {
	if (href.startsWith("data:")) return decodeURIComponent(href.slice(href.indexOf(",") + 1));
	return get(href).then((r) => r.text(), () => undefined);
}
export function badgeOf(map: ManifestMap, view: Face, phase: Phase): Badge {
	const badge = map[view].badge ?? map.standard.badge!;
	return "dot" in badge ? badge : badge[phase];
}
/** The icon's data URL for `n` waiting: the plain icon, or with the dot and the count (9+ above nine). */
export function iconHref(plain: string, n: number, badge: Badge) {
	const dot = `<circle cx='23' cy='9' r='9' fill='${badge.dot}' stroke='${badge.ring}' stroke-width='2'/><text x='23' y='13' text-anchor='middle' font-family='sans-serif' font-size='${n > 9 ? 9 : 12}' font-weight='700' fill='${badge.text}'>${n > 9 ? "9+" : n}</text>`;
	return `data:image/svg+xml,${encodeURIComponent(n ? plain.replace("</svg>", `${dot}</svg>`) : plain)}`;
}
