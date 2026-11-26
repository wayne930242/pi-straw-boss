import { m } from "./sentences.ts";
import { noun } from "./nouns.ts";
import { createPrefs, prefs } from "./prefs.ts";
import { baseLocale, type Locale, locales, overwriteGetLocale, toLocale } from "./paraglide/runtime.js";

// The page's language. The messages are Paraglide's (gui/messages/<locale>.json, compiled into gui/paraglide); this module only picks the
// locale, once when the page loads: the one chosen in the language menu, else the browser's first language the page has, else English. A
// Chinese tag maps by script, so zh-HK reads Traditional Chinese and zh-SG Simplified once that locale exists. Pinning the locale keeps
// Paraglide from resolving it on every message call. Choosing another reloads the page, which draws every view in it afresh.

/** A browser language tag as one of the page's locales: the tag itself, Chinese by script or region, or its base language. */
export function match(tag: string): Locale | undefined {
	const zh = /^zh\b/i.test(tag) && (/-(hant|tw|hk|mo)\b/i.test(tag) ? "zh-TW" : /-(hans|cn|sg|my)\b/i.test(tag) ? "zh-CN" : undefined);
	return toLocale(tag) ?? (zh ? toLocale(zh) : undefined) ?? toLocale(tag.split("-")[0]);
}
export function pick(stored: string | null, languages: readonly string[]): Locale {
	return toLocale(stored) ?? languages.map(match).find(Boolean) ?? baseLocale;
}

// Static text of index.html, by its data-m (text), data-m-label (aria-label), data-m-title (title), and data-m-empty (what CSS shows while it is empty) attributes.
const PAGE: Record<string, () => string> = {
	brand_label: m.brand_label, head_tower: () => noun("head_tower"), menu_more: m.menu_more, tagline: m.tagline, totals_label: m.totals_label, stat_bases: m.stat_bases, stat_agents: m.stat_agents, stat_working: m.stat_working,
	stat_waiting: m.stat_waiting, stat_commanding: m.stat_commanding, mark_commanding: m.mark_commanding, alerts: m.alerts, no_alerts: m.no_alerts, link_connecting: m.link_connecting, connect_connecting: m.connect_connecting, connect_retry: m.connect_retry,
	location: m.location, all_bases: m.all_bases, documents: () => noun("documents"), comms: () => noun("comms"), outposts: () => noun("outposts"), outside_net: () => noun("outside_net"), timeline: m.timeline, states: m.states, mark_working: m.mark_working,
	mark_waiting: m.mark_waiting, mark_idle: m.mark_idle, mark_done: m.mark_done, mark_error: m.mark_error, credit: m.credit, language: m.language, view_label: m.view_label, view_auto: m.view_auto, view_standard: m.view_standard, view_geek: m.view_geek, view_zen: m.view_zen, view_raven: m.view_raven, view_storybook: m.view_storybook, zen_enter: m.zen_enter, zen_enter_title: m.zen_enter_title, view_title: m.view_title, settings: m.settings, new_base: m.new_base, back: m.back, remind: m.remind, sound_effects: m.sound_effects, sound_background: m.sound_background, sound_volume: m.sound_volume, sound_try: m.sound_try, sound_effects_title: m.sound_effects_title, sound_background_title: m.sound_background_title, set_device: m.set_device, set_device_note: m.set_device_note, set_phone: m.set_phone, set_teams: m.set_teams, set_server: m.set_server,
};
export const pageKeys = Object.keys(PAGE);

/** Keeps `next` as the device's language and reloads the page in it; false when the storage refused. The settings page's menu and the Zen menu both choose through this. */
export function setLocale(next: string, store: Pick<Storage, "setItem"> = localStorage, reload: () => void = () => location.reload()) {
	if (!createPrefs(store).set("locale", next)) return false;
	reload();
	return true;
}
export const localeNames = () => locales.map((l) => ({ id: l as string, name: m.locale_name({}, { locale: l }) }));

const put: Record<string, (el: HTMLElement, v: string) => void> = { m: (el, v) => (el.textContent = v), mLabel: (el, v) => el.setAttribute("aria-label", v), mTitle: (el, v) => (el.title = v), mEmpty: (el, v) => (el.dataset.empty = v) };
/** Translates the page's static text again (at start, and when a theme's role nouns take effect). */
export function retranslate() {
	for (const el of document.querySelectorAll<HTMLElement>("[data-m], [data-m-label], [data-m-title], [data-m-empty]"))
		for (const [attr, set] of Object.entries(put)) if (el.dataset[attr]) set(el, PAGE[el.dataset[attr]]?.() ?? el.dataset[attr]);
}

/** Pins the locale, translates the page's static text, and fills the language menu. */
export function startI18n() {
	const locale = pick(prefs.get("locale"), navigator.languages ?? [navigator.language]);
	overwriteGetLocale(() => locale);
	document.documentElement.lang = locale;
	retranslate();
	const menu = document.getElementById("lang") as HTMLSelectElement;
	menu.replaceChildren(...locales.map((l) => new Option(m.locale_name({}, { locale: l }), l, false, l === locale)));
	menu.onchange = () => setLocale(menu.value) || (menu.value = locale); // storage refused: a reload could not keep the choice
}
