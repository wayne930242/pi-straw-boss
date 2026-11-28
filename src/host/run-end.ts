// A run's end as sb's host tells it (docs/specs/2026-11-28-todo-preflight.md B). Maestro (the weihung fork since sb-host-a5a9c43) names on every `subagent_result`
// and `subagent_ping` the run id its launch or resume acknowledged (`details.id`), the run's `elapsed`, and every spawned attempt (`attempts`, a fallback's failed
// ones included). As each end goes out, the host sends `subagent:run-end` on pi.events: pi-todo-ledger counts the end by it even when its message never reaches
// the model (a steer cleared before its turn), once by the run id. An end without a run id sends no event: the host never guesses which run it closed.

export const RUN_END_EVENT = "subagent:run-end";
const ENDS = new Set(["subagent_result", "subagent_ping"]);

type Json = Record<string, unknown>;
const obj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const seconds = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** One spawned attempt as the event carries it. */
export interface RunAttempt { model?: string; sessionFile?: string; elapsed?: number }
/** The event's payload (pi-todo-ledger CONTRACT.md "Run spend"): `v`, `id` and `kind` always; the rest when the end names them. */
export interface RunEnd { v: 1; id: string; kind: "result" | "ping"; name?: string; item?: string; sessionFile?: string; elapsed?: number; attempts?: RunAttempt[] }

/** The run-end event of a message the host sends, or undefined for any other message and for an end that names no run id. */
export function runEndOf(message: { customType?: string; details?: unknown }): RunEnd | undefined {
	const d = message.details;
	if (!ENDS.has(message.customType ?? "") || !obj(d) || !text(d.id)) return undefined;
	const attempts = Array.isArray(d.attempts)
		? d.attempts.flatMap((a): RunAttempt[] => (obj(a) ? [{ ...(text(a.model) ? { model: a.model } : {}), ...(text(a.sessionFile) ? { sessionFile: a.sessionFile } : {}), ...(seconds(a.elapsed) ? { elapsed: a.elapsed } : {}) }] : []))
		: [];
	return {
		v: 1, id: d.id, kind: message.customType === "subagent_ping" ? "ping" : "result",
		...(text(d.name) ? { name: d.name } : {}), ...(text(d.item) ? { item: d.item } : {}), ...(text(d.sessionFile) ? { sessionFile: d.sessionFile } : {}),
		...(seconds(d.elapsed) ? { elapsed: d.elapsed } : {}), ...(attempts.length ? { attempts } : {}),
	};
}
