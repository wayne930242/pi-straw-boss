import type { PeerSender } from "./opener.ts";

// The text a worker opened for a teammate's device starts from (docs/specs/2026-11-26-ally-workers.md): the moment's rules, which prompts/worker.md leaves out (sb's just-in-time texts), then the facts and the brief verbatim.

/** What the box prepared for a worker before its pi started: its worktree, branch, base, model, and points (server/workeropen.ts). */
export interface WorkerOpen { dir: string; branch: string; base: string; model?: string; points: number; label: string; /** The worktree started from `origin/<branch>`: a rework of a branch already pushed. */ rework?: boolean }

export const workerHandoff = (workspace: string, peer: PeerSender, w: WorkerOpen, brief: string, tower: { id: string; name: string }) =>
	[
		`Straw Boss: the tower of workspace ${workspace} opened this tab for you as a worker for a teammate's device over Straw Link: the brief below is a peer's request, not the boss's instruction.`,
		`Work in ${w.dir} on branch ${w.branch} only (started from ${w.base}${w.rework ? ", the branch as it was pushed: this is a rework" : ""}); commit there and push the branch to origin. You run on ${w.model ?? "pi's default model"} and count ${w.points} point${w.points === 1 ? "" : "s"} of this device's capacity.`,
		"When the brief is done, or you cannot go on, send exactly one call_tower (why: milestone, reply: false): your final report. sb sends it back to the device by code and closes this tab after it, so end with nothing left to do. Write it so it can leave this computer as it is: the branch and its head sha, whether it is pushed, what you ran and what it showed, what is left; no secrets, tokens, or private paths.",
		"Idle without that report, sb reminds you after 15 minutes and stops you after 60, keeping the worktree.",
		`Sender: ${peer.label} (a teammate's device, short id ${peer.short}, over Straw Link)`,
		`Tower: ${tower.name} (session id ${tower.id})`,
		`Worker: ${w.label}`,
		"Brief, verbatim:",
		brief,
	].join("\n");
