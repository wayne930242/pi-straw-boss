import { m } from "./sentences.ts";
import type { Alert } from "./alerts.ts";
import { audio, type SoundClass } from "./audio.ts";
import { prefs } from "./prefs.ts";
import { soundOf } from "./themesounds.ts";
import waitingUrl from "./sounds/waiting.mp3";

// Reminders and sounds for the alerts a snapshot raises: a unit waiting on an answer, one that finished, one that failed.
// Each has a switch on the settings page (This device), kept per browser: reminders on, sounds off, so a page that opens makes no noise. The switch is a button that says its
// state in a word (On, Off). Sound is two classes (todo #139), each with a switch and a volume (0 to 100, default 60) under it: Sound effects (this cue, with a try) and Background sound (Zen's music, Raven's rain and thunder,
// which play from their own code, so this file only keeps its switch and volume); the sounds play through Web Audio, whose gain an iPhone honours (it ignores an audio element's volume).
// A reminder is a system notification while the page is hidden or unfocused (the alert queue shows it on a focused page); clicking it brings the page forward on that unit.
// A sound effect is for what waits on the boss alone (boss, 2026-11-24: 「我們應該只需要 需要使用者注意 的時候放音效（背景音）除外」, 「我甚至覺得 finished 的音效拿掉」): a question, a dialog
// pending, a trust prompt, and a new link notice that needs an answer ring the question clip; a finish and a failure play none and show a silent system notification, and the supply board makes no sound.

type Kind = "waiting" | "error" | "done";
const kindOf = (a: Alert): Kind | undefined => (a.mark === "waiting" || a.pending ? "waiting" : a.mark === "error" ? "error" : a.mark === "done" ? "done" : undefined);

export interface Notifier { signal(fresh: Alert[]): void; /** Zen: the system notification for a card that waits while the page is hidden or unfocused, one for each card, those behind the card on the screen included (no clip). */ remind(a: Alert): void; /** The question clip, when Sound effects is on: new link notices that need the boss (linkbar.ts). */ chime(): void; /** The two classes' switches and volumes as the settings page has them (the Zen menu and its palette drive the same). */ sound: Record<SoundClass, Switch> }
/** A class's switch and volume. `try` is the sample after a volume change (Background has none: what it plays is already audible). `onChange` is called after any change, a local one or another tab's (the Zen menu redraws, the music follows). */
export interface Switch { on(): boolean; volume(): number; set(on: boolean): void; setVolume(v: number): void; try(): void; onChange(fn: () => void): void }

/** Mounts the settings page's reminder switch (`#remind`) and the two sound classes' switches with their volumes (`#effects`, `#effects-vol`, `#background`, `#background-vol`) and returns what plays a snapshot's new alerts. */
export function mountNotify(open: (a: Alert) => void): Notifier {
	const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
	const remindBtn = $<HTMLButtonElement>("remind");
	const can = typeof Notification !== "undefined";
	let remind = prefs.get("remind");
	const draw = () => {
		const perm = can ? Notification.permission : "denied";
		remindBtn.setAttribute("aria-pressed", String(remind));
		// On but not yet allowed: the next press asks the browser; refused: the browser's settings decide.
		remindBtn.dataset.state = !remind ? "off" : perm === "granted" ? "on" : perm === "denied" ? "blocked" : "ask";
		remindBtn.title = !can ? m.remind_unsupported() : !remind ? m.remind_off() : perm === "granted" ? m.remind_on() : perm === "denied" ? m.remind_blocked() : m.remind_ask();
		$("remind-note").textContent = remindBtn.title; // a phone has no hover: the page says what the state means
		// The state in a word (the button's text; the Standard view adds a dot, the Geek view brackets), never by colour alone.
		remindBtn.textContent = { off: m.state_off, on: m.state_on, blocked: m.state_blocked, ask: m.state_ask }[remindBtn.dataset.state as "off"]();
	};
	remindBtn.onclick = async () => {
		if (remind && can && Notification.permission === "default") await Notification.requestPermission().catch(() => {});
		else prefs.set("remind", (remind = !remind));
		draw();
	};
	// One class: its switch (`#<class>`), its volume (`#<class>-vol`), and its stored pair. The volume reaches the playback core at mount and at each change, the class's gain alone.
	const strip = (cls: SoundClass, sample: () => void, onSwitch?: () => void): Switch => {
		const btn = $<HTMLButtonElement>(cls), vol = $<HTMLInputElement>(`${cls}-vol`), volOut = $<HTMLOutputElement>(`${cls}-vol-out`), told: (() => void)[] = [];
		const volKey = `${cls}Volume` as const;
		let on = prefs.get(cls), volume = prefs.get(volKey);
		const drawn = () => {
			btn.dataset.state = on ? "on" : "off";
			btn.textContent = on ? m.state_on() : m.state_off();
			btn.setAttribute("aria-pressed", String(on));
			vol.value = volOut.value = String(volume);
			audio.volume(cls, volume);
		};
		const changed = () => (drawn(), told.forEach((f) => f()));
		prefs.on(cls, () => ((on = prefs.get(cls)), changed())); // another tab's switch applies here
		prefs.on(volKey, () => ((volume = prefs.get(volKey)), changed()));
		const set = (next: boolean) => (prefs.set(cls, (on = next)), changed(), next && onSwitch?.());
		btn.onclick = () => set(!on);
		vol.oninput = () => (prefs.set(volKey, (volume = Number(vol.value))), changed());
		vol.onchange = sample;
		drawn();
		return { on: () => on, volume: () => volume, set, setVolume: (v) => (prefs.set(volKey, (volume = v)), changed()), try: sample, onChange: (fn) => void told.push(fn) };
	};
	// Each press here lets the page play, and turning the effects on says what they sound like: the question clip, their one sound.
	const ring = () => audio.play(soundOf("waiting", waitingUrl), waitingUrl);
	const effects = strip("effects", ring, ring), background = strip("background", () => {});
	$("effects-try").onclick = ring;
	/** The system notification of an alert, while the page is hidden or unfocused and Remind is on and allowed. */
	function notice(a: Alert, k: Kind) {
		if (!remind || !can || Notification.permission !== "granted" || (!document.hidden && document.hasFocus())) return;
		const n = new Notification(a.name, { body: a.trust ? m.trust_reminder() : { waiting: m.notify_waiting, error: m.notify_error, done: m.notify_done }[k]({ note: a.note ?? "" }).trim(), tag: a.key, icon: document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href, silent: k !== "waiting" }); // only a question may make the system beep: a failure or a finish is a quiet notice
		n.onclick = () => (window.focus(), n.close(), open(a));
	}
	draw();
	return {
		remind: (a) => notice(a, "waiting"),
		sound: { effects, background },
		chime: () => effects.on() && ring(),
		signal(fresh) {
			const due = fresh.flatMap((a) => ((k) => (k ? [{ a, k }] : []))(kindOf(a)));
			if (effects.on() && due.some((d) => d.k === "waiting")) ring();
			for (const { a, k } of due) notice(a, k);
		},
	};
}
