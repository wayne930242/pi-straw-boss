import type { TowerService } from "../src/net.ts";
import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";
import { actionWhy } from "./towermodel.ts";

// What the session view says about a tower the sb server runs, apart from the map (towermodel.ts): the turns of a run that the server wrote, what a refused send was, and what stands where a terminal would be. The view's own chunk loads it.

type Opts = { locale?: "en" | "zh-TW" };

/**
 * A user turn in a tower's run that the server wrote, not the boss: the first line is the server's (src/runmode.ts `eventText`), written from the broker's sender and cleaned, so only it is read. The boss's
 * own turn opens with another marker and stays the boss's.
 */
export function heard(text: string | undefined): { kind: "intercom"; from: string } | { kind: "server" | "timer" } | undefined {
	const first = (text ?? "").split("\n", 1)[0]!;
	if (first.startsWith("[intercom from ") && first.endsWith("]")) return { kind: "intercom", from: first.slice("[intercom from ".length, -1) };
	if (first === "[notice from the sb server]") return { kind: "server" };
	if (first === "[your wakeAfter follow-up is due]") return { kind: "timer" };
}

/** What the tower refused to a send, in the page's language: by the code the page's server gives, else by the reasons it is known to give; undefined for any other (the server's own words stay). */
export function towerWhy(r: Pick<Answer, "status" | "body">, o?: Opts): string | undefined {
	if (r.status < 400) return undefined;
	if (r.body.error === "standing") return m.tower_err_standing({}, o);
	if (r.body.error === "server_queue") return m.tower_err_server_queue({}, o);
	return actionWhy(r, o);
}

/** The sentence that stands where a terminal would be, for a tower with no run live (the server answers its keys and mirror with 409 `standing`); undefined when it has one. */
export function termHold(service: TowerService | undefined, o?: Opts): string | undefined {
	if (!service || service.run) return undefined;
	return service.state === "held" ? m.tower_term_held({}, o) : m.tower_term_standing({}, o);
}
