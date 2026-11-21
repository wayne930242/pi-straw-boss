import { m } from "./sentences.ts";
import type { Answer } from "./post.ts";

// The refusals of a terminal's keys and mirror (src/keys.ts, src/mirror.ts, a pane's src/answerpane.ts, and the session routes of src/control.ts) name themselves by a code and say it in English. The page says it in its own language by the code,
// and shows the server's words only for a code it does not know. The mirror's `ended` frames carry only English text, so they are matched by it. Both the pad and the terminal card read here.
const CODE: Record<string, () => string> = {
	no_mirror: m.refuse_no_mirror, blocked: m.refuse_blocked, lan_overlay_open: m.refuse_lan_overlay_open, local_only: m.refuse_local_only, rate: m.refuse_rate, no_key: m.refuse_no_key, text: m.refuse_text, paste: m.refuse_paste,
	key: m.refuse_key, bad_request: m.refuse_bad_request, not_live: m.refuse_not_live, unavailable: m.refuse_unavailable, too_many: m.refuse_too_many,
	standing: m.refuse_standing, not_found: m.refuse_not_found, pane_closed: m.refuse_pane_closed, busy: m.refuse_busy, run_unknown: m.refuse_run_unknown, run_expired: m.refuse_run_expired, run_changed: m.refuse_run_changed, operate_refused: m.refuse_operate_refused,
};
/** An operate refusal says why by a word of its own beside the code; every word the box, the keys and the routes give has page words (src/keys.ts, src/probe.ts, src/control.ts, src/operateseam.ts, src/operateroutes.ts, src/server/operatescope.ts). */
const OPERATE_WHY: Record<string, () => string> = {
	binding: m.refuse_operate_binding, "binding-unread": m.refuse_operate_binding_unread, foreground: m.refuse_operate_foreground, terminal: m.refuse_operate_terminal, unread: m.refuse_operate_unread, noanswer: m.refuse_operate_noanswer, shell: m.refuse_operate_shell,
	"boss-command": m.refuse_operate_boss_command, command: m.refuse_operate_command, draft: m.refuse_operate_draft, ended: m.refuse_operate_ended, route: m.refuse_operate_route, "enter-chord": m.refuse_operate_enter_chord, chord: m.refuse_operate_chord,
	"leaves-editor": m.refuse_operate_leaves_editor, "out-of-scope": m.refuse_operate_out_of_scope, "not-granted": m.refuse_operate_not_granted, "not-admin": m.refuse_operate_not_admin, "local-only": m.refuse_operate_local_only, policy: m.refuse_operate_policy,
};
export const OPERATE_WHY_WORDS = Object.keys(OPERATE_WHY);
const ENDED: Record<string, () => string> = {
	"The session is no longer live in this pane.": m.ended_not_live, "The pane runs something else now.": m.ended_other, "The pane closed.": m.ended_closed, "The pane could not be read.": m.ended_unreadable, "The session moved to another pane.": m.ended_moved,
};
export const REFUSAL_CODES = Object.keys(CODE);
const say = (fn: (() => string) | undefined, locale?: string) => (fn as ((i: object, o?: object) => string) | undefined)?.({}, locale ? { locale } : undefined);
/** What an operate box refused, in the page's words by its why word; none for another error or a word the page has no sentence for (the box's own text stays). */
export const operateWhy = (r: Pick<Answer, "status" | "body">, locale?: string) => (r.body.error === "operate_refused" && typeof r.body.why === "string" && Object.hasOwn(OPERATE_WHY, r.body.why) ? say(OPERATE_WHY[r.body.why], locale) : undefined);
/** A refused write or attach in the page's words by the server's code; an unknown code shows the server's text, and none shows the status. */
export const refusalText = (r: Answer, locale?: string) => operateWhy(r, locale) ?? say(CODE[String(r.body.error)], locale) ?? r.body.reason ?? m.refused({ status: r.status }, locale ? { locale: locale as "en" } : undefined);
/** The mirror's `ended` reason in the page's words, or as the server wrote it. */
export const endedWhy = (why: string, locale?: string) => say(ENDED[why], locale) ?? why;
