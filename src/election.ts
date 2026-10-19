import type { Channel, Kit } from "./state.ts";

/** Who is the tab's main: the owner of the tab channel records it, and decides the claims members send. */
export function createElection({ cfg, s, me, tell }: Kit) {
	// The owner records who is main. Promotion is first come, first served, and the main stays until it leaves: a later owner change never swaps it.
	const pin = (channel: Channel, main?: string) => {
		if (channel.snapshot().owner?.sessionId !== me()) return;
		channel.commitState({ v: 1, ...(main ? { main } : {}), since: cfg.now() });
		if (channel === s.c) s.pinned = main;
	};
	// The owner decides a claim: a tab has one main, so a claim is dropped while a live main exists, unless the user forced it with /boss.
	const claim = async (channel: Channel, from: string, force: boolean) => {
		try {
			if (channel.snapshot().owner?.sessionId !== me()) return;
			const current = (channel === s.c ? s.pinned : undefined) ?? (channel.snapshot().state?.payload as { main?: string } | undefined)?.main;
			if (!force && current && current !== from && (await channel.listSessions()).some((x) => x.id === current)) return;
			pin(channel, from);
		} catch (error) {
			tell(`Straw Boss: ${(error as Error).message}`, "warning");
		}
	};
	return { pin, claim };
}
export type Election = ReturnType<typeof createElection>;
