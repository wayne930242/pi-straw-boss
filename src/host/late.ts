import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: unknown) => unknown;

/**
 * An ExtensionAPI for an engine that loads at session start instead of in the factory (rivals.ts says why). Its tools, commands and renderers
 * register on Pi as they would at load (Pi refreshes its tool list after a late `registerTool`). Its event handlers are kept here: one dispatcher per
 * event is registered on Pi the first time the engine asks for that event, and `session_start` is run by the host entry itself, so the session start in
 * progress reaches the engine once, and every later one through the entry's own handler.
 */
export function lateApi(pi: ExtensionAPI): { api: ExtensionAPI; run(event: string, payload: unknown, ctx: unknown): Promise<unknown> } {
	const handlers = new Map<string, Handler[]>(), wired = new Set<string>(["session_start"]);
	const run = async (event: string, payload: unknown, ctx: unknown) => {
		let out: unknown;
		for (const handler of [...(handlers.get(event) ?? [])]) {
			const result = await handler(payload, ctx);
			if (result !== undefined) out = result;
		}
		return out;
	};
	const on = (event: string, handler: Handler) => {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		if (!wired.has(event)) {
			wired.add(event);
			(pi.on as (event: string, handler: Handler) => void)(event, (payload, ctx) => run(event, payload, ctx));
		}
		return () => void handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
	};
	const api = Object.assign(Object.create(pi) as ExtensionAPI, { on });
	return { api, run };
}
