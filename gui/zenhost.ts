import type { StepEvent, StepKind } from "./cardmodel.ts";
import { h } from "./dom.ts";
import { termCard } from "./termcard.ts";
import type { TermKit } from "./zentypes.ts";

// What the Zen terminal layer's host holds (zenterm.ts is the layer around it): in card mode the terminal card, in full mode the page's own terminal, or, for a tower with no run live, the sentence that stands for one.

type Mode = "card" | "full";
/** How a step ended: its Enter was taken, the unit worked again (an armed terminal), or the pane is gone. */
export type Done = "taken" | "working" | "gone";
/** `kind`: what ends the step (`plain`: a terminal opened to look at, which only the boss ends). `drawn`: what the host holds now. `held`: the sentence for a tower with no run live. */
export interface Open { name: string; key: string; kind: StepKind | "plain"; mode: Mode; /** The step is over (`done`): a quiet line in its bar, then the layer drifts back to Zen (zenterm.ts `DRIFT_MS`) unless the boss touches it. */ done?: Done; /** Cancels that drift: the boss tapped, typed, or scrolled in the layer (Z-D20). */ stay?: () => void; command?: string; run?: string; asker?: string; /** The unit's box takes no input now (remote base: unreachable or ended), read by the card at every draw. */ away?: () => boolean; kit?: TermKit; card?: ReturnType<typeof termCard>; drawn?: "card" | "full" | "hold"; held?: string; layer: HTMLElement; host: HTMLElement; hint: HTMLElement; note: HTMLElement; back: HTMLElement; off?: () => void }
export interface Layer {
	/** Whether `c` is the layer on show. */
	live(c: Open): boolean;
	/** A step event: when the step's rule says it is over, the layer says so and drifts back to Zen (`done`). */
	step(c: Open, e: StepEvent): void;
	/** The card's own step is over (its Enter was taken, or its pane is gone). */
	done(c: Open, why: Done): void;
	close(): void;
}

/** The card's Full terminal: the same layer, the full terminal in its host. The terminal joins the connection the card holds before the card lets go of it, so there is one attach. */
function toFull(c: Open, on: Layer) {
	const card = c.card;
	[c.mode, c.card, c.drawn, c.off] = ["full", undefined, undefined, undefined];
	c.layer.setAttribute("data-mode", "full");
	draw(c, on);
	card?.stop();
}
/** Puts the right thing in the host for the mode and the tower's state. */
export function draw(c: Open, on: Layer) {
	const kit = c.kit;
	if (!kit || !on.live(c)) return;
	if (c.mode === "card") {
		if (c.card) return c.card.update(c.name);
		const key = c.key, card = (c.card = termCard({
			step: { kind: c.kind === "pane" ? "pane" : "prompt", key, name: c.name, command: c.command, run: c.run },
			watch: (w) => kit.watch(key, c.name, w),
			post: kit.post(key),
			stream: kit.stream,
			away: () => c.away?.() === true,
			held: () => c.held,
			over: (why) => on.live(c) && (why === "full" ? toFull(c, on) : why !== "closed" && on.done(c, why)),
			escape: false,
			close: false,
			enter: true,
		}));
		[c.off, c.drawn] = [card.stop, "card"];
		c.host.replaceChildren(card.el);
		if (!globalThis.matchMedia?.("(pointer: fine)").matches) c.back.focus(); // a phone's keyboard comes with the card's own button
		else card.focus();
		return;
	}
	if (c.held) {
		if (c.drawn === "hold") return;
		c.off?.();
		[c.off, c.drawn] = [undefined, "hold"];
		return c.host.replaceChildren(h("p", { class: "term-hold", role: "status" }, c.held));
	}
	if (c.drawn === "full") return;
	c.drawn = "full";
	c.host.replaceChildren();
	c.off = kit.embed(c.key, c.name, c.host, { keys: true, end: () => on.step(c, { type: "end" }), taken: () => on.step(c, { type: "taken" }) });
}
