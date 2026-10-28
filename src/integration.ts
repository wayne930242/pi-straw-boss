import { panes } from "./herdr.ts";
import type { Kit } from "./state.ts";

// Herdr's pi integration (desk-mode spec S6): Herdr names a pane's pi session (`agent_session`) only when its integration is installed for the agent directory, and a session without that name cannot join the net.
// Without the integration Herdr still sees the agent, so a session checks its own pane once, `cfg.integrationMs` after its start, and says what is missing.

const MISSING = "Herdr's pi integration is missing for this agent directory, so this session cannot join the net; run `herdr integration install pi` and restart pi.";

/** One warning per session: `arm` at each session start, `stop` at its end. A listing that fails says nothing; the next session of this process does not warn again. */
export function createIntegrationWatch({ cfg, s, tell }: Kit) {
	let timer: ReturnType<typeof setTimeout> | undefined, warned = false;
	const stop = () => (clearTimeout(timer), (timer = undefined));
	const check = async () => {
		timer = undefined;
		const mine = (await panes(cfg.run, s.at.workspaceId).catch(() => [])).find((p) => p.pane_id === s.at.paneId);
		if (mine?.agent && !mine.agent_session?.value && !warned) {
			warned = true;
			tell(MISSING, "warning");
		}
	};
	return {
		arm() {
			if (warned || timer) return;
			timer = setTimeout(() => void check(), cfg.integrationMs);
			timer.unref();
		},
		stop,
	};
}
export type IntegrationWatch = ReturnType<typeof createIntegrationWatch>;
