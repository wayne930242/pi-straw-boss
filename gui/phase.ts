// Storybook's day and night (docs/specs/2026-11-26-storybook-theme/spec.md §B2): the device's local clock decides, day 06:00 to 17:59, night 18:00 to 05:59. No server time and no setting (O2, O9).
// The one source of the rule: boot.js carries a copy (`phase(hours)`), checked against this for every hour (tests/storybook-phase.test.ts). The demo forces a phase with `&phase=day|night` (main.ts), for screenshots only.

export type Phase = "day" | "night";
export const DAY_FROM = 6, NIGHT_FROM = 18;
export const phaseAt = (date: Date): Phase => (date.getHours() >= DAY_FROM && date.getHours() < NIGHT_FROM ? "day" : "night");
/** The next moment the phase changes after `date`: the next 06:00 or 18:00 of the local clock. */
export function nextBoundary(date: Date): Date {
	const next = new Date(date.getTime());
	next.setMinutes(0, 0, 0);
	const h = date.getHours();
	if (h < DAY_FROM) next.setHours(DAY_FROM);
	else if (h < NIGHT_FROM) next.setHours(NIGHT_FROM);
	else next.setDate(next.getDate() + 1), next.setHours(DAY_FROM);
	return next;
}

let forced: Phase | undefined;
/** The demo's `&phase=`: every later read says this phase. */
export const forcePhase = (phase: Phase | undefined) => void (forced = phase);
/** The demo's forced phase, if any. */
export const forcedPhase = (): Phase | undefined => forced;
/** The phase now, the demo's forced one first. */
export const phaseNow = (now: () => Date = () => new Date()): Phase => forced ?? phaseAt(now());
