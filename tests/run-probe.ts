// The Maestro owner's synchronous bus reply. No listener leaves the request untouched.
export const runRow = (id: string, agent = "worker") => ({ id, name: id, agent, persistent: false, delivery: "pending" });
export function runBus(rows?: () => ReturnType<typeof runRow>[]) {
	return replyBus(rows && (() => ({ version: 1, runs: rows() })));
}
/** A bus whose owner answers `reply()` as it is, malformed or not; `undefined` is no answer. */
export function replyBus(reply?: () => unknown) {
	return { emit(channel: string, request: unknown) {
		const snapshot = channel === "pi-herdr-agents:runs:v1" ? reply?.() : undefined;
		if (snapshot !== undefined) Object.assign(request as object, { snapshot });
	} };
}
