import { randomBytes } from "node:crypto";

// The overlay-open mark of `/boss gui lan` (docs/specs/2026-10-30-sb-gui-lan.md, "Approval on this computer", *Not from a paired device*, D9). While any face of the overlay (warning, certificate, pairing, pending, reset) is open in a session,
// the overlay holds a mark on its pane here, at the server, and the routes that write into a pane (`input`, `keys`, `dequeue`) look at it right before each write: a paired device may then send Escape only. The state comes from the
// extension that owns the overlay, not from the screen (AGENTS.md, Design). The mark is a lease (5 s, renewed by the overlay's 1 s poll), so a pi that crashed or hung leaves a mark for at most 5 s; renewing or dropping one needs its
// face id (16 random bytes), so a process that names another pane can only add a mark there, never clear one.
//
// The server keeps, per pane, the time of the last write a paired device made that was not Escape. A face's answer (an approval, the risk accepted, a reset) is refused when such a write came less than `SETTLE_MS` before the face opened
// or after: a key that passed its check before the mark was set can still be read by the overlay once it mounts.

/** How long a mark lives without a renewal. */
export const LEASE_MS = 5000;
/** The grace before a face's open in which a paired device's write still taints the face's answers (the confirm of `link_request` waits the same 1.5 s). */
export const SETTLE_MS = 1500;
/** Faces kept at once; a flood of opens past it drops the oldest lapsed one first, else is refused. */
const MAX_FACES = 64;
/** Panes remembered for their last paired write. */
const MAX_PANES = 512;
const PANE = /^[A-Za-z0-9:_.-]{1,64}$/;

interface Face { id: string; pane: string | null; opened: number; until: number }

/** Why a face's answer is not taken: the face is not live (never was, lapsed, or closed), or a paired device wrote into its pane as it opened. */
export type FaceVerdict = { ok: true } | { ok: false; error: "unknown_face" | "typed_into" };

export function createFaces(now: () => number = Date.now) {
	const faces = new Map<string, Face>(), wrote = new Map<string, number>();
	const sweep = () => {
		const t = now();
		for (const [id, face] of faces) if (face.until <= t) faces.delete(id);
	};
	const live = (id: unknown): Face | undefined => {
		if (typeof id !== "string") return undefined;
		const face = faces.get(id);
		if (!face) return undefined;
		if (face.until <= now()) return void faces.delete(id);
		return face;
	};
	return {
		/** A face opens in `pane` (null: a pi outside Herdr, which has no pane the GUI can type into): its id, or undefined when the pane is not a pane id or there are too many faces. */
		open(pane: unknown): string | undefined {
			if (pane !== null && (typeof pane !== "string" || !PANE.test(pane))) return undefined;
			sweep();
			if (faces.size >= MAX_FACES) return undefined;
			const id = randomBytes(16).toString("hex"), t = now();
			faces.set(id, { id, pane, opened: t, until: t + LEASE_MS });
			return id;
		},
		/** The overlay's poll: false when the face is unknown (the server restarted, or the lease lapsed), and the overlay then opens a new one. */
		renew(id: unknown): boolean {
			const face = live(id);
			if (!face) return false;
			face.until = now() + LEASE_MS;
			return true;
		},
		close(id: unknown): boolean {
			const face = live(id);
			return face ? faces.delete(face.id) : false;
		},
		/** Whether any live face holds a mark on `pane`: a paired device's write there is Escape only. Called right before each write. */
		marked(pane: string | undefined): boolean {
			if (!pane) return false;
			sweep();
			for (const face of faces.values()) if (face.pane === pane) return true;
			return false;
		},
		/** Whether any face at all is live (for deciding whether a pending request needs a session notice). */
		any(): boolean {
			sweep();
			return faces.size > 0;
		},
		/** A paired device is about to write something other than Escape into `pane` (noted right before the Herdr call). */
		wrote(pane: string | undefined) {
			if (!pane) return;
			wrote.delete(pane);
			wrote.set(pane, now());
			for (const old of wrote.keys()) if (wrote.size > MAX_PANES) wrote.delete(old);
		},
		/** Whether a face's answer is taken: the face is live, and no paired device wrote into its pane since `SETTLE_MS` before it opened. */
		accepts(id: unknown): FaceVerdict {
			const face = live(id);
			if (!face) return { ok: false, error: "unknown_face" };
			const at = face.pane === null ? undefined : wrote.get(face.pane);
			return at !== undefined && at >= face.opened - SETTLE_MS ? { ok: false, error: "typed_into" } : { ok: true };
		},
	};
}
export type Faces = ReturnType<typeof createFaces>;
/** What the writing routes need of the marks. */
export type Overlay = Pick<Faces, "marked" | "wrote">;
