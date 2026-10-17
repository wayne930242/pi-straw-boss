import { defineConfig } from "vite";

// `npm run gui:build` bundles the page into dist/gui, the static bundle `/boss gui` serves and the package ships.
// `npm run gui:dev` serves it with hot reload against a demo fixture; GUI_LIVE=<url printed by /boss gui> feeds it that live stream instead.
export default defineConfig(({ command }) => {
	let live: URL | undefined;
	try {
		live = process.env.GUI_LIVE ? new URL(process.env.GUI_LIVE) : undefined;
	} catch {
		throw new Error(`GUI_LIVE is not a URL: ${process.env.GUI_LIVE}; set it to the URL /boss gui printed`);
	}
	return {
		root: import.meta.dirname,
		base: "./",
		// The live server writes <base href> into the page it serves; the dev server does the same so routes like /w/<id>/s/<key> load.
		plugins: [{ name: "dev-base", apply: "serve", transformIndexHtml: (html: string) => html.replace("<head>", '<head>\n<base href="/">') }],
		define: { __LIVE__: JSON.stringify(command === "build" || Boolean(live)) },
		build: { outDir: "../dist/gui", emptyOutDir: true, sourcemap: false, modulePreload: false },
		server: {
			host: "127.0.0.1",
			// The live server answers only under its token path and its own Host header, so the proxy rewrites both, for the stream and the history API.
			proxy: live && Object.fromEntries(["/events", "/api"].map((at) => [at, { target: live!.origin, changeOrigin: true, rewrite: (path: string) => `${live!.pathname.replace(/\/$/, "")}${path}` }])),
		},
	};
});
