// The documentation site, served on GitHub Pages under the GUI demo: https://wayne930242.github.io/pi-straw-boss/docs/.
// Pages under reference/how-it-works, guide/unattended-device, and releases are generated from docs/ by scripts/sync.mjs.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import mermaid from "astro-mermaid";
import starlightLinksValidator from "starlight-links-validator";
import cjkNewlines from "./cjk-newlines.mjs";

export default defineConfig({
	site: "https://wayne930242.github.io",
	base: "/pi-straw-boss/docs",
	trailingSlash: "always",
	integrations: [
		// Both before starlight(): they add Sätteri plugins to the processor Starlight then extends.
		mermaid({ autoTheme: true, enableLog: false }),
		cjkNewlines(),
		starlight({
			title: "pi-straw-boss",
			description: "Many pi agents, one project, no collisions: a main agent per Herdr tab, a tower per workspace, and a live view of who is doing what.",
			defaultLocale: "root",
			locales: {
				root: { label: "English", lang: "en" },
				"zh-tw": { label: "繁體中文", lang: "zh-TW" },
			},
			social: [{ icon: "github", label: "GitHub", href: "https://github.com/wayne930242/pi-straw-boss" }],
			editLink: { baseUrl: "https://github.com/wayne930242/pi-straw-boss/edit/main/site/" },
			lastUpdated: false,
			customCss: ["./src/styles/custom.css"],
			sidebar: [
				{
					label: "Start here",
					translations: { "zh-TW": "開始" },
					items: ["guide/install", "guide/quick-start", "guide/concepts"],
				},
				{
					label: "Guides",
					translations: { "zh-TW": "指南" },
					items: [
						"guide/browser-view",
						"guide/phone",
						"guide/head-tower",
						"guide/auto-mode",
						"guide/merge-train",
						"guide/straw-link",
						"guide/unattended-device",
						"guide/herdr-plugins",
						"guide/process-hygiene",
					],
				},
				{
					label: "Reference",
					translations: { "zh-TW": "參考" },
					items: ["reference/commands", "reference/configuration"],
				},
				{
					label: "How it works",
					translations: { "zh-TW": "運作方式" },
					collapsed: true,
					items: [{ autogenerate: { directory: "reference/how-it-works" } }],
				},
				{
					label: "Releases",
					translations: { "zh-TW": "版本紀錄" },
					collapsed: true,
					items: [{ autogenerate: { directory: "releases" } }],
				},
			],
			plugins: [starlightLinksValidator({ errorOnFallbackPages: false })],
		}),
	],
});
