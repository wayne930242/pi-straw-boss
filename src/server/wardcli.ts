// `cli.mjs ward` (docs/how-it-works.md#ward-a-plain-pane): refused. A ward is its main's own: the server sets, lists, and stops it only for the main's pi process, which proves itself with the registration secret the server handed it
// (carbook.ts `sessionOf`, boss decision on ward-review F003). A shell holds no such secret, so the command only points to the tool. Exit code 1.

export const WARD_CLI_REFUSED = "cli.mjs ward is retired: a ward is set and stopped only from the main's own pi session, with the sb_ward tool (the server checks that session's registration secret, which a shell does not hold)";
export function runWard(io: { err(text: string): void }): number {
	io.err(`${WARD_CLI_REFUSED}\n`);
	return 1;
}
