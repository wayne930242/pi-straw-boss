import { join } from "node:path";
import { readLinkConfig } from "./config.ts";
import { replayEncoded } from "./roster.ts";
import { inside } from "./routing.ts";
import { LinkStore } from "./store.ts";

// Where a main's board entry goes (docs/specs/2026-10-25-straw-link.md, Work board, Writing): the teams whose project holds the main's directory and whose
// `share` is `status`. Read from config.json and the team files alone, so a pi main and a Claude Code or Codex sidecar main say the same without the holder.

export interface BoardTarget { name: string; devices: number }

export function boardTargets(stateDir: string, dir: string, o: { home: string; agentDir: string }): BoardTarget[] {
	const config = readLinkConfig(stateDir, o);
	if (config.teams.size === 0) return [];
	const store = new LinkStore(join(stateDir, "link"));
	return [...config.teams].flatMap(([team, policy]): BoardTarget[] => {
		if (policy.share !== "status" || !inside(dir, policy.project)) return [];
		let devices = 0;
		try {
			const file = store.readTeam(team), replay = replayEncoded(Buffer.from(team, "hex"), file.entries.map((e) => Buffer.from(e, "base64url")));
			if (replay.ok) devices = Math.max(0, replay.value.members.size - 1);
		} catch { /* no team file: the entry goes nowhere yet */ }
		return [{ name: policy.name, devices }];
	});
}

/** The sentence `board_set` answers with: where the text goes, so a main learns before its next write that it leaves the computer. */
export function wentTo(targets: BoardTarget[]): string {
	return ["local towers", ...targets.map((t) => `team ${t.name} (${t.devices} device${t.devices === 1 ? "" : "s"})`)].join("; ");
}
