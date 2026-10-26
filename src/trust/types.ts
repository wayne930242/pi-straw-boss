// What the trust question is made of (docs/specs/2026-10-26-project-trust.md): shared by the asking pi, the server, and the page, which imports types only.

/** One resource of the folder that trusting would load; `unreadable` marks a file that could not be read or parsed (its items are then empty). */
export interface TrustGroup { kind: string; path: string; items: string[]; more: number; unreadable?: true }
/** The asking pi's request file (`<id>.json`); the server lists it only while the process lives and Herdr lists its pane. */
export interface TrustRequest { version: 1; id: string; pid: number; started?: string; herdr: string; pane: string; role: string; cwd: string; at: number; found: TrustGroup[]; digest: string }
/** The three choices of the alert, and what the asking pi answers pi with. */
export type TrustChoice = "trust" | "once" | "no";
export const CHOICES: readonly TrustChoice[] = ["trust", "once", "no"];
/** The server's answer file (`<id>.answer.json`). */
export interface TrustAnswer { version: 1; id: string; digest: string; choice: TrustChoice; answerId: string }
/** The asking pi's result file (`<id>.result.json`), written just before it returns: which side answered. */
export interface TrustResult { version: 1; id: string; by: "remote" | "terminal" | "gone"; answerId?: string; at: number }
/** One entry of the snapshot's `trust`: a folder and digest with the agents waiting on it (D8). `opening` names the page's opening that waits on it. */
export interface TrustAsk { id: string; digest: string; folder: string; found: TrustGroup[]; agents: { pane: string; base?: string; tab?: string; role: string; at: number }[]; opening?: string }
