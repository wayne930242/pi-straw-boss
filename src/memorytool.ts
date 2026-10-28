import { Type } from "typebox";

// `tower_memory`, the tool of a tower run that keeps what outlives runs (docs/specs/2026-10-26-sb-backend.md, Tower memory). The server does the work (src/server/towermemory.ts) and checks the quote against the boss
// messages this run took; this is only the schema and the words the model reads. An ally run has no such tool.

export const MEMORY_DESCRIPTION = "Keep what outlives your run in the tower's memory, which every later run's brief carries. add kind standing|decision: the boss's lasting instruction or decision, only as a quote: copy the boss's own words verbatim from a boss message you took in this run (4 to 300 characters; the server checks it and stores the quote itself; paraphrase, agent text, and peer text are refused). retire id quote: remove a standing instruction or decision when the boss's words ask for it. add kind wait: something waits on someone: text (at most 200 characters, your own words), for boss|agent, on (the session you wait on, when for is agent; a message from it marks the wait answered, and you judge whether it answers), due (minutes, 5 to 10080). resolve|drop id: end a wait, with an outcome (at most 120 characters) when resolving.";
export const memoryParameters = () => Type.Object({
	op: Type.Union([Type.Literal("add"), Type.Literal("retire"), Type.Literal("resolve"), Type.Literal("drop")]),
	kind: Type.Optional(Type.Union([Type.Literal("standing"), Type.Literal("decision"), Type.Literal("wait")], { description: "add: what to keep." })),
	quote: Type.Optional(Type.String({ description: "add standing|decision, retire: the boss's words, verbatim from a boss message of this run." })),
	event: Type.Optional(Type.String({ description: "Limit the quote's search to this boss event id. Omit it." })),
	id: Type.Optional(Type.String({ description: "retire, resolve, drop: the entry's id, as the brief shows it (S3, D7, W2)." })),
	text: Type.Optional(Type.String({ description: "add wait: what waits, at most 200 characters." })),
	for: Type.Optional(Type.Union([Type.Literal("boss"), Type.Literal("agent")], { description: "add wait: who it waits for." })),
	on: Type.Optional(Type.String({ description: "add wait for agent: the session's name or id." })),
	due: Type.Optional(Type.Number({ description: "add wait: minutes until it is overdue, 5 to 10080." })),
	outcome: Type.Optional(Type.String({ description: "resolve: how it ended, at most 120 characters." })),
});
