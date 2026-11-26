// The first frame's view, before the body exists (docs/specs/2026-11-07-raven-view/spec.md §1.2). A classic script with no imports, so it blocks nothing but the parser: the page entry's module has not run yet.
// It resolves the page's face as gui/view.ts and gui/mode.ts do on a fresh load: Zen while the mode is on (`sb.zen` 1, or with none stored the legacy `sb.view` zen; docs/specs/2026-11-26-storybook-theme/spec.md A3; the route is not known yet, and main.ts
// corrects a settings route), else the device's theme (the stored choice, then the server's default in <meta name="sb-view">, then prefers-contrast). It puts the face on <html> as data-view, sets the theme-color and the tab icon, and, when the
// face is a theme whose stylesheet the server did not already link, writes that link (parser-inserted, so it blocks the first paint). tests/view.test.ts and tests/zen-mode.test.ts run this file against view.ts's `resolve` and mode.ts.
// The theme map is <meta name="sb-themes"> (the build writes it into index.html); an entry marked `mode` (Zen) is no view name. Anything wrong here (no storage, no map) leaves the page as the server wrote it: main.ts corrects the face and loads the theme as today.
(function () {
	var d = document, root = d.documentElement;
	function meta(name) {
		var m = d.querySelector('meta[name="' + name + '"]');
		return m ? m.getAttribute("content") : null;
	}
	var themes = {};
	try {
		themes = JSON.parse(meta("sb-themes") || "{}") || {};
	} catch (e) {}
	var names = ["standard"];
	for (var k in themes) if (Object.prototype.hasOwnProperty.call(themes, k) && !(themes[k] && themes[k].mode)) names.push(k);
	/** A name of a view, anything else is Auto. */
	function choice(value) {
		return typeof value === "string" && names.indexOf(value) >= 0 ? value : "auto";
	}
	/** gui/view.ts `resolve(choiceOf(stored), contrast, choiceOf(server))`. */
	function resolve(stored, contrast, server) {
		var own = choice(stored), shared = choice(server);
		if (own !== "auto") return own;
		if (shared !== "auto") return shared;
		return contrast && names.indexOf("geek") >= 0 ? "geek" : "standard";
	}
	/** gui/mode.ts: `sb.zen` says, and with none stored the legacy `sb.view` (prefs.ts LEGACY). */
	function zen(storedZen, storedView) {
		return storedZen !== null ? storedZen === "1" : storedView === "zen";
	}
	/** What the page shows first: Zen while the mode is on, else the theme. */
	function face(storedView, storedZen, contrast, server) {
		return zen(storedZen, storedView) ? "zen" : resolve(storedView, contrast, server);
	}
	/** gui/phase.ts `phaseAt`: day from 06:00 to 17:59 by the device's clock, night otherwise (docs/specs/2026-11-26-storybook-theme/spec.md §B2). */
	function phase(hours) {
		return hours >= 6 && hours < 18 ? "day" : "night";
	}
	globalThis.sbBoot = { resolve: resolve, face: face, phase: phase };
	try {
		var stored = null, storedZen = null;
		try {
			stored = localStorage.getItem("sb.view");
			storedZen = localStorage.getItem("sb.zen");
		} catch (e) {} // storage refused: the screen and the server decide, and the mode is off
		var view = face(stored, storedZen, matchMedia("(prefers-contrast: more)").matches, meta("sb-view"));
		root.dataset.view = view;
		var now = phase(new Date().getHours());
		var theme = Object.prototype.hasOwnProperty.call(themes, view) ? themes[view] : undefined;
		if (theme && theme.phases === "day-night") root.dataset.phase = now;
		if (view !== "standard" && theme && theme.color) {
			var bar = d.querySelector('meta[name="theme-color"]');
			if (bar) {
				if (!bar.hasAttribute("data-standard")) bar.setAttribute("data-standard", bar.getAttribute("content") || ""); // Standard's, which view.ts paints on leaving Zen or another theme (RV-F002)
				bar.setAttribute("content", typeof theme.color === "string" ? theme.color : theme.color[now]);
			}
		}
		var icon = d.querySelector('link[rel="icon"]');
		if (icon && !(theme && theme.icon) && icon.hasAttribute("data-standard")) icon.setAttribute("href", icon.getAttribute("data-standard")); // the server wrote its default's icon; this device's view has none
		if (theme && theme.icon) {
			if (icon) {
				if (!icon.hasAttribute("data-standard")) icon.setAttribute("data-standard", icon.getAttribute("href") || ""); // main.ts draws Standard's icon from it
				icon.setAttribute("href", theme.icon);
			}
		}
		if (theme && theme.css && !d.querySelector('link[data-theme="' + view + '"]')) d.write('<link rel="stylesheet" data-theme="' + view + '" href="' + theme.css + '">');
	} catch (e) {}
})();
