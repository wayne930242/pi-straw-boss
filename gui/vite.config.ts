import { defineConfig } from "vite";

// `npm run gui:build` bundles the page into dist/gui, the static bundle `/boss gui` serves and the package ships.
// `npm run gui:dev` serves it with hot reload against a demo fixture; GUI_LIVE=<url printed by /boss gui> feeds it that live stream instead.
// `npm run gui:demo` builds the demo (the fixture, no server) into dist/demo for GitHub Pages, under GUI_DEMO, the path it is served from.
export default defineConfig(({ command }) => {
	let live: URL | undefined;
	try {
		live = process.env.GUI_LIVE ? new URL(process.env.GUI_LIVE) : undefined;
	} catch {
		throw new Error(`GUI_LIVE is not a URL: ${process.env.GUI_LIVE}; set it to the URL /boss gui printed`);
	}
	const demo = process.env.GUI_DEMO;
	if (demo !== undefined && !/^\/([\w.-]+\/)*$/.test(demo)) throw new Error(`GUI_DEMO is the path the demo is served from, such as /pi-straw-boss/; got ${demo}`);
	return {
		root: import.meta.dirname,
		base: "./",
		// The live server writes <base href> into the page it serves; the dev server does the same so routes like /w/<id>/s/<key> load.
		// The demo has no server to write it, so its build carries the base it is served under.
		plugins: [{ name: "dev-base", apply: demo === undefined ? "serve" : "build", transformIndexHtml: (html: string) => html.replace("<head>", `<head>\n<base href="${demo ?? "/"}">`) }],
		define: { __LIVE__: JSON.stringify((command === "build" && demo === undefined) || Boolean(live)) },
		// Sounds stay files, fetched when one first plays, instead of inlined into the map's chunk.
		build: { outDir: demo === undefined ? "../dist/gui" : "../dist/demo", emptyOutDir: true, sourcemap: false, modulePreload: false, assetsInlineLimit: (file: string) => (file.endsWith(".mp3") ? false : undefined) },
		server: {
			host: "127.0.0.1",
			// The live server answers only under its token path and its own Host header, so the proxy rewrites both, for the stream and the history API.
			proxy: live && Object.fromEntries(["/events", "/api"].map((at) => [at, { target: live!.origin, changeOrigin: true, rewrite: (path: string) => `${live!.pathname.replace(/\/$/, "")}${path}` }])),
		},
	};
});
