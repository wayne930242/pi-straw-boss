import { defineConfig } from "vite";

// `npm run gui:build` bundles the page into dist/gui, the static bundle `/boss gui` serves and the package ships.
// `npm run gui:dev` serves it with hot reload against a demo fixture; GUI_LIVE=<url printed by /boss gui> feeds it that live stream instead.
export default defineConfig(({ command }) => {
	const live = process.env.GUI_LIVE ? new URL(process.env.GUI_LIVE) : undefined;
	return {
		root: import.meta.dirname,
		base: "./",
		define: { __LIVE__: JSON.stringify(command === "build" || Boolean(live)) },
		build: { outDir: "../dist/gui", emptyOutDir: true, sourcemap: false },
		server: {
			host: "127.0.0.1",
			// The live server answers only under its token path and its own Host header, so the proxy rewrites both.
			proxy: live && { "/events": { target: live.origin, changeOrigin: true, rewrite: (path: string) => `${live.pathname.replace(/\/$/, "")}${path}` } },
		},
	};
});
