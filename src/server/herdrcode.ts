/** The code Herdr itself gave a failed command (`timeout`, `agent_pane_busy`, ...): from its stderr, as JSON (`{"error":{"code":..}}`) or as the leading word before a colon; never from the message, which repeats the command line. */
export function herdrCode(cause: unknown): string | undefined {
	const stderr = (cause as { stderr?: unknown } | undefined)?.stderr;
	if (typeof stderr !== "string") return undefined;
	try {
		const body = JSON.parse(stderr) as { code?: unknown; error?: { code?: unknown } | string };
		const code = typeof body.error === "object" ? body.error?.code : body.code;
		if (typeof code === "string") return code;
	} catch { /* plain text */ }
	return /^([a-z][a-z0-9_]*):/.exec(stderr.trim())?.[1];
}
