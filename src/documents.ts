import { randomBytes } from "node:crypto";
import type { Bus } from "./owners.ts";

// Document contract v1 (pi-herdr-doc-review ≥ 0.4.0, its README's "Browser viewers"): the package that shows a session's documents (its
// owner) publishes the full list on pi's event bus at every change and delivers form answers itself, exactly as a Chawan submission. The
// bridge (bridge.ts) relays the list with its dialogs; the hub (dialogs.ts) binds it to the unit with the dialog binding rule and gives each
// document a capability, 128 random bits per server; the page gets the capability and never a path; the server serves by it (docs.ts).

export const LIST = "doc-review:documents", REQUEST = "doc-review:documents-request", FORM = "doc-review:form", RESULT = "doc-review:form-result";
const MAX_DOCS = 32, FORM_MS = 4000;
export const MAX_FIELDS = 64;
export interface Doc { id: string; path: string; kind: "html" | "text"; display: string; reason: string; revision: number; onScreen: boolean }
/** A document as the page sees it: its capability instead of its path and owner id. */
export interface DocCard { cap: string; display: string; kind: "html" | "text"; reason: string; revision: number; onScreen: boolean }
/** A unit's documents in the snapshot; `docsCut` when its list was too long to relay (they stay in the terminal). */
export interface Shelf { docs?: DocCard[]; docsCut?: true }
export interface FormResult { accepted: boolean; reason?: string }
export type Fields = [string, string][];

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
/** One entry; its display and reason are cut to 1024 and 2048 characters (show_doc's reason has no limit), anything else out of shape refuses it. */
const docOf = (d: Record<string, unknown> | undefined): Doc | undefined => {
	if (!str(d?.id, 64) || !str(d.path, 4096) || !d.path.startsWith("/") || (d.kind !== "html" && d.kind !== "text") || typeof d.display !== "string" || typeof d.reason !== "string" || !Number.isSafeInteger(d.revision) || (d.revision as number) < 1 || typeof d.onScreen !== "boolean") return;
	return { id: d.id, path: d.path, kind: d.kind, display: d.display.slice(0, 1024), reason: d.reason.slice(0, 2048), revision: d.revision as number, onScreen: d.onScreen };
};
/** A contract-v1 list, or undefined (another version or shape: a relay never guesses at one). Ids are unique. */
export function docsOf(raw: unknown): Doc[] | undefined {
	const p = raw as { version?: unknown; documents?: unknown };
	if (p?.version !== 1 || !Array.isArray(p.documents) || p.documents.length > MAX_DOCS) return;
	const docs = p.documents.map(docOf);
	return docs.every(Boolean) && new Set(docs.map((d) => d!.id)).size === docs.length ? (docs as Doc[]) : undefined;
}
export const fieldsOk = (f: unknown): f is Fields => Array.isArray(f) && f.length <= MAX_FIELDS && f.every((x) => Array.isArray(x) && x.length === 2 && x.every((s) => typeof s === "string"));

/** The owner's list as it changes. A v1 list out of shape counts as none, so an older list never stays; another version is ignored. A viewer that starts late asks for the list once. */
export function listenDocs(bus: Bus, list: (docs: Doc[]) => void): () => void {
	const off = bus.on(LIST, (raw) => (raw as { version?: unknown })?.version === 1 && list(docsOf(raw) ?? []));
	bus.emit(REQUEST, { version: 1 });
	return off;
}
/** Hands one form answer to the owner and reports its result once (nothing when the owner stays silent for 4 s). */
export function submitForm(bus: Bus, id: string, answerId: string, fields: Fields, done: (r: FormResult) => void) {
	let finished = false;
	const finish = (r?: FormResult) => (finished || ((finished = true), off(), clearTimeout(timer), r && done(r)));
	const off = bus.on(RESULT, (raw) => {
		const r = raw as { version?: unknown; id?: unknown; answerId?: unknown; accepted?: unknown; reason?: unknown };
		if (r?.version === 1 && r.id === id && r.answerId === answerId && typeof r.accepted === "boolean") finish({ accepted: r.accepted, ...(str(r.reason, 512) ? { reason: r.reason } : {}) });
	});
	const timer = setTimeout(finish, FORM_MS);
	timer.unref?.();
	bus.emit(FORM, { version: 1, id, answerId, fields });
}

/** The hub's capabilities: one per (session, bridge, document) while its bridge lists that document, new for every server (`clear`). A list cut
 *  for size lists nothing meanwhile, so its documents get new capabilities when they fit again. */
export function createCaps() {
	let caps = new Map<string, string>(), held = new Map<string, { key: string; from: string; bridgeId: string; id: string }>();
	return {
		/** One reading: each bound unit's lists by key; `listed` holds `from\nbridgeId\nid` of every relayed document, and a capability not in it goes. */
		bind(units: { key: string; from: string; bridgeId: string; docs: Doc[] }[], listed: Set<string>): Map<string, DocCard[]> {
			const cards = new Map<string, DocCard[]>();
			for (const k of caps.keys()) if (!listed.has(k)) caps.delete(k);
			held = new Map();
			for (const { key, from, bridgeId, docs } of units)
				cards.set(key, docs.map(({ id, kind, display, reason, revision, onScreen }) => {
					const k = `${from}\n${bridgeId}\n${id}`, cap = caps.get(k) ?? randomBytes(16).toString("hex");
					caps.set(k, cap);
					held.set(cap, { key, from, bridgeId, id });
					return { cap, display, kind, reason, revision, onScreen };
				}));
			return cards;
		},
		find: (cap: string) => held.get(cap),
		clear: () => ((caps = new Map()), (held = new Map())),
	};
}
