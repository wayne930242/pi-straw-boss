import { Type } from "typebox";

// `tower_memory`, the tool of a tower run that keeps what outlives runs (docs/specs/2026-10-26-sb-backend.md, Tower memory). The server does the work (src/server/towermemory.ts); this is only the schema and the words the
// model reads. A run only proposes a standing instruction or a decision: the boss confirms in the GUI or with /boss memory, and no op here can. An ally run has no such tool.

export const MEMORY_DESCRIPTION = "Keep what outlives your run in the tower's memory, which every later run's brief carries. You can only PROPOSE the boss's lasting instructions and decisions; the boss confirms or rejects each proposal in the GUI or with /boss memory, and until then it is pending and no instruction (you cannot confirm one). add kind standing|decision: propose it, text (at most 300 characters, in the boss's meaning and, where you can, words), and event (optional: the id of the boss message of this run it comes from; the boss sees that message beside your proposal). retire id: propose retiring a standing instruction or decision, with event when a boss message asks for it. At most 12 proposals wait at once and one expires after 7 days. read: list the whole memory and the pending proposals (what a brief left out). add kind wait: something waits on someone: text (at most 200 characters, your own words), for boss|agent, on (the session you wait on, when for is agent; a message from it marks the wait answered, and you judge whether it answers), due (minutes, 5 to 10080). resolve|drop id: end a wait, with an outcome (at most 120 characters) when resolving.";
export const memoryParameters = () => Type.Object({
	op: Type.Union([Type.Literal("add"), Type.Literal("retire"), Type.Literal("read"), Type.Literal("resolve"), Type.Literal("drop")]),
	kind: Type.Optional(Type.Union([Type.Literal("standing"), Type.Literal("decision"), Type.Literal("wait")], { description: "add: what to keep or propose." })),
	event: Type.Optional(Type.String({ description: "add standing|decision, retire: the id of the boss message of this run the proposal comes from; the boss sees it as context." })),
	id: Type.Optional(Type.String({ description: "retire, resolve, drop: the entry's id, as the brief shows it (S3, D7, W2)." })),
	text: Type.Optional(Type.String({ description: "add standing|decision: the proposal, at most 300 characters. add wait: what waits, at most 200 characters." })),
	for: Type.Optional(Type.Union([Type.Literal("boss"), Type.Literal("agent")], { description: "add wait: who it waits for." })),
	on: Type.Optional(Type.String({ description: "add wait for agent: the session's name or id." })),
	due: Type.Optional(Type.Number({ description: "add wait: minutes until it is overdue, 5 to 10080." })),
	outcome: Type.Optional(Type.String({ description: "resolve: how it ended, at most 120 characters." })),
});
