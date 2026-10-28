import { type Level, type LinkConfig } from "./config.ts";
import { type PolicyDeps, readPolicy } from "./policy.ts";

// The level this computer gives a device (docs/specs/2026-10-25-straw-link.md, Trust levels): the policy file's on an unattended device, config.json's `link.trust` otherwise, `reply` when none names it
// or when the policy file is refused (said once). The remote-turn hooks of a session read it for each message they see, and the sb server reads it when it claims an ally run for a device
// (docs/specs/2026-10-26-sb-backend.md, Ally runs: the run\'s level is fixed at the claim, and its hooks take the lower of the two).

export interface LevelDeps {
	config: () => LinkConfig;
	policy?: PolicyDeps;
	log: (event: Record<string, unknown>) => void;
	tell: (text: string, level?: "info" | "warning" | "error") => void;
}
export function createLevelOf({ config, policy, log, tell }: LevelDeps): (device: string) => Level {
	let refusedTold = "";
	return (device) => {
		const found = readPolicy(policy);
		if (found.mode === "unattended") return found.trust.get(device) ?? "reply";
		if (found.mode === "refused") {
			if (refusedTold !== found.reason) (refusedTold = found.reason, log({ event: "policy-refused", reason: found.reason }), tell(`Straw Link: unattended mode is refused (${found.reason}); every sender stays at reply`, "error"));
			return "reply";
		}
		return config().trust.get(device) ?? "reply";
	};
}
