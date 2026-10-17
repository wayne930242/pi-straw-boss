// The page's routes, below the server's <base href> (/<token>/): the net map, one workspace, one session. Ids are encoded in the path, so
// any session id or workspace id round-trips; real <a href> links work with middle-click and copy-link, and a plain click navigates without a reload.

export type Route = { view: "map" } | { view: "workspace"; ws: string } | { view: "session"; ws: string; key: string };

const decode = (part: string) => {
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
};
// A segment of only dots would be read as a path step by the browser, so its dots are escaped too.
const enc = (part: string) => (/^\.+$/.test(part) ? part.replaceAll(".", "%2E") : encodeURIComponent(part));

/** The route for the part of the path after the base ("", "w/<ws>", "w/<ws>/s/<key>"); anything else is the map. */
export function parseRoute(rel: string): Route {
	const [w, ws, s, key] = rel.split(/[?#]/)[0]!.replace(/^\/+|\/+$/g, "").split("/").map(decode);
	if (w !== "w" || !ws) return { view: "map" };
	return s === "s" && key ? { view: "session", ws, key } : { view: "workspace", ws };
}
export const formatRoute = (r: Route) => (r.view === "map" ? "" : r.view === "workspace" ? `w/${enc(r.ws)}` : `w/${enc(r.ws)}/s/${enc(r.key)}`);
/** One level up: session to workspace to map. */
export const upOf = (r: Route): Route => (r.view === "session" ? { view: "workspace", ws: r.ws } : { view: "map" });
/** What the stream is asked to watch on this route. */
export const watchOf = (r: Route) => (r.view === "session" ? r.key : r.view === "workspace" ? `w:${r.ws}` : null);

export interface Router { route(): Route; go(route: Route): void; href(route: Route): string }

/** History API routing: `go` pushes a state, Back and Forward call `onRoute`, and clicks on `a[data-route]` navigate in place. */
export function createRouter(onRoute: (route: Route) => void, base = new URL(document.baseURI).pathname): Router {
	const route = () => parseRoute(location.pathname.slice(base.length));
	const router: Router = {
		route,
		href: (r) => formatRoute(r) || "./",
		go(next) {
			const path = base + formatRoute(next);
			if (location.pathname !== path) history.pushState(null, "", path);
			onRoute(next);
		},
	};
	addEventListener("popstate", () => onRoute(route()));
	document.addEventListener("click", (event) => {
		const link = (event.target as Element | null)?.closest?.("a[data-route]");
		if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		router.go(parseRoute(link.getAttribute("data-route")!));
	});
	return router;
}
