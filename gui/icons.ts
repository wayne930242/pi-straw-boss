// The role icons: one chokepoint, `iconRef(role)`; `unitIcon(role, duty)` names the icon a unit takes, its kind's (docs/specs/2026-11-09-agent-kinds.md D16) or its position's. Standard's sprite is inline in index.html (`#i-<role>`, with its game-icons credit) and stays for every view. A theme's sprite is injected into a hidden <svg id="theme-sprite">
// with ids prefixed by the view (`raven-tower`); while it is loaded and has the role, that view's icon is used, else Standard's. Elements made from a template or set once carry `data-icon="<role>"`, so a theme arriving
// (or the view changing) points them again with `repoint`.

/** The icon of each role (position): the keys of Standard's sprite a unit, a tower or a row takes. */
export const ICON: Record<string, string> = { main: "main", member: "member", train: "train", subagent: "subagent", outpost: "outpost", outside: "outside", tower: "tower", ally: "tower", run: "tower" };
import { isCoordinatorDuty, isWorkerDuty } from "../src/duty.ts";
/** A unit's kind icon is `#i-<duty>` in Standard's sprite, only on its position: coordinator kinds on a main, worker kinds on a subagent (src/duty.ts); a train's is its role's (`ICON.train`). */
/** The icon id of a unit's kind when its role can have one and the duty is a kind. */
export const kindIcon = (role: string, duty?: string): string | undefined => (role === "main" ? isCoordinatorDuty(duty) : role === "subagent" ? isWorkerDuty(duty) : false) ? duty : undefined;
/** The icon id of a unit: its kind's, else its position's (a unit with no known kind looks as it did, and the tower and the head keep theirs). */
export const unitIcon = (role: string, duty?: string): string => kindIcon(role, duty) ?? ICON[role] ?? "member";

const sprites = new Map<string, Set<string>>();
let view = "standard";

/** The `<use>` target for a role or duty in the view the page shows now. */
export const iconRef = (role: string) => (sprites.get(view)?.has(`${view}-${role}`) ? `#${view}-${role}` : `#i-${role}`);

/** Sets `href` on the `<use data-icon>` elements under `root` (an element made from a template calls it for itself). */
export function repoint(root: ParentNode = document) {
	for (const use of root.querySelectorAll<SVGUseElement>("use[data-icon]")) {
		const href = iconRef(use.dataset.icon!);
		if (use.getAttribute("href") !== href) use.setAttribute("href", href);
	}
}

/** The view whose icons `iconRef` names from now on. */
export function useIcons(next: string, svg?: string) {
	if (svg !== undefined && !sprites.has(next)) {
		const sheet = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" id="theme-sprite-${next}" width="0" height="0" style="position:absolute" aria-hidden="true">${svg}</svg>`, "image/svg+xml").documentElement;
		document.body.append(document.importNode(sheet, true));
		sprites.set(next, new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map((id) => id[1]!)));
	}
	view = next;
	repoint();
}
