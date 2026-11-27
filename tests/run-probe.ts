// The Maestro owner's synchronous bus reply. No listener leaves the request untouched.
export const runRow = (id: string, agent = "worker") => ({ id, name: id, agent, persistent: false, delivery: "pending" });
export function runBus(rows?: () => ReturnType<typeof runRow>[]) {
	return { emit(channel: string, request: unknown) {
		if (channel === "pi-herdr-agents:runs:v1" && rows) Object.assign(request as object, { snapshot: { version: 1, runs: rows() } });
	} };
}
