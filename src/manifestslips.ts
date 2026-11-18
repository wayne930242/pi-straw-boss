import { bodyOf, fieldsOf } from "./headerfields.ts";
import { parseSlip, slipBlocks, slipLines } from "./train/accept.ts";
import type { CarRow } from "./train/board.ts";
import { type CarView, currentLife, endOf, forwardsOf } from "./train/cars.ts";
import { isObject, type Json } from "./train/spec.ts";
import type { Row } from "./trainboard.ts";
import { trainFromRequest } from "./trainrole.ts";

// The integrator's departure (boss W45, train 2026-11-17-q): the manifest the integrator sends the tower carries every car's slip because sb appends it, never because the model restates it. The tower hands the train the manifest verbatim, and the
// train's own manifest check (trainguard.ts `parseManifest`) reads the cars only from slip blocks: a manifest that named its slips by path gave the train no car, so it could set no car's fate. The slips come from the tower's forwards on the
// integrator's branch (the source `train_car received` reads), for the car rows of the integrator's `train` todo of the manifest's code.
// A car the integrator ended before the open (returned or dropped once received, TCR-F003) is refused here rather than left out: the train todo would still list it, and a train opened with its head could set it nothing (`already returned`), so the todo
// and the manifest stay one list and the integrator takes the car off the todo.

const short = (head: string) => head.slice(0, 12);
const LEAVE_OUT = "leave the slips out of the manifest: sb appends each car's slip verbatim from the tower's forward";
/** One slip block, compared line by line without the white space at the ends of its lines. */
const same = (a: string, b: string) => {
	const norm = (s: string) => s.split(/\r?\n/).map((l) => l.trimEnd()).join("\n").trim();
	return norm(a) === norm(b);
};

/** The slip block of a forward on the branch that carries this head, newest forward first (the server's book takes the newest forward of a head too). */
function forwardedSlip(forwards: ReturnType<typeof forwardsOf>, head: string): string | undefined {
	for (const forward of [...forwards].reverse()) {
		const block = slipBlocks(slipLines(bodyOf(forward.text))).blocks.find((b) => parseSlip(b).fields.head === head);
		if (block) return block;
	}
	return undefined;
}

/**
 * The integrator's `call_tower` message with every car's forwarded slip appended, or the refusal that sends nothing; undefined when the message is no train manifest (it names no `project:` and train `code:`, as the open reads them).
 * A slip block the message holds already must be the forwarded slip of a car of the train todo, word for word, and is not appended again. `views` is the sb server's book of the project (`cars-read`): a car whose life there has ended rides no train.
 */
export function manifestWithSlips(message: string, rows: readonly Row[], entries: readonly unknown[], views: readonly CarView[]): { message: string } | { refusal: string } | undefined {
	const id = trainFromRequest(message);
	if ("refusal" in id) return undefined;
	const sbOf = (r: Row) => (isObject(r.metadata?.sb) ? (r.metadata!.sb as Json) : undefined);
	const todo = rows.filter((r) => { const s = sbOf(r); return s?.kind === "train" && s.project === id.project && s.train === id.code; }).at(-1);
	if (!todo) return { refusal: `sb: no train todo of project ${id.project} names train ${id.code}: create it with its cars as the slips give them (and set it in_progress) before the manifest's call` };
	const spec = sbOf(todo)!.spec, cars = (isObject(spec) && Array.isArray(spec.cars) ? spec.cars : []).filter((c): c is CarRow => isObject(c) && typeof c.head === "string");
	const forwards = forwardsOf(entries, fieldsOf), slips = new Map<string, string>();
	for (const car of cars) {
		if (slips.has(car.head)) continue;
		const block = forwardedSlip(forwards, car.head);
		if (!block) return { refusal: `sb: car ${car.tickets?.[0] ?? "?"} (${short(car.head)}) of the train todo has no forward by the tower on this branch: sb appends each car's slip from the tower's forward, so its coordinator sends the slip to the tower again (call_tower why=shared), the tower forwards it, and then call again` };
		const life = currentLife(views, parseSlip(block).fields.car ?? String(sbOf(todo)!.app), car.head), ended = life ? endOf(life.file) : undefined;
		if (ended) return { refusal: `sb: car ${car.tickets?.[0] ?? "?"} (${short(car.head)}) of the train todo is ${ended.state} in the sb server's book (set ${ended.at}): an ended car rides no train, so take it off the train todo, then call again` };
		slips.set(car.head, block);
	}
	const held = new Set<string>();
	for (const block of slipBlocks(message).blocks) {
		const parsed = parseSlip(block), head = parsed.fields.head, ticket = parsed.tickets[0] ?? parsed.fields.branch ?? "unknown", theirs = head ? slips.get(head) : undefined;
		if (!head || !theirs) return { refusal: `sb: the manifest's slip of car ${ticket} names head ${head ? short(head) : "none"}, which is no car of the train todo of ${id.code}: ${LEAVE_OUT}` };
		if (!same(block, theirs)) return { refusal: `sb: the manifest's slip of car ${ticket} (${short(head)}) differs from the slip the tower forwarded: ${LEAVE_OUT}` };
		held.add(head);
	}
	const missing = [...slips].filter(([head]) => !held.has(head)).map(([, block]) => block);
	return missing.length ? { message: `${message.replace(/\s+$/, "")}\n\n${missing.join("\n\n")}\n` } : { message };
}
