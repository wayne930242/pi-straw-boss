import { panes } from "./herdr.ts";
import type { Kit } from "./state.ts";

// Herdr's pi integration (desk-mode spec S6): Herdr names a pane's pi session (`agent_session`) only when its integration is installed for the agent directory, and a session without that name cannot join the net.
// Without the integration Herdr still sees the agent, so a session checks its own pane once, `cfg.integrationMs` after its start, and says what is missing.

const MISSING = "Herdr's pi integration is missing for this agent directory, so this session cannot join the net; run `herdr integration install pi` and restart pi.";

/** One warning per process: `arm` at each session start, `stop` at its end. A listing that fails says nothing; a later session of this process does not warn again. */
export function createIntegrationWatch({ cfg, tell }: Kit) {
	let timer: ReturnType<typeof setTimeout> | undefined, warned = false, generation = 0;
	const stop = () => (generation++, clearTimeout(timer), (timer = undefined));
	const check = async () => {
		timer = undefined;
		const mark = generation, pane = cfg.env.HERDR_PANE_ID;
		if (!pane) return;
		const mine = (await panes(cfg.run).catch(() => [])).find((p) => p.pane_id === pane);
		if (mark === generation && mine?.agent && !mine.agent_session?.value && !warned) {
			warned = true;
			tell(MISSING, "warning");
		}
	};
	return {
		arm() {
			if (warned || timer) return;
			timer = setTimeout(() => void check().catch(() => {}), cfg.integrationMs);
			timer.unref();
		},
		stop,
	};
}
export type IntegrationWatch = ReturnType<typeof createIntegrationWatch>;
