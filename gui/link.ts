import type { JoinRequestView, JoinView, MemberView, TeamView } from "../src/link/admin.ts";
import type { LinkView } from "../src/link/holder.ts";
import { h, nodes } from "./dom.ts";
import type { Tile } from "./layer.ts";
import { countdown, lastSeen } from "./linkmodel.ts";
import { square } from "./pair.ts";
import { m } from "./paraglide/messages.js";
import { folderPicker } from "./picker.ts";
import { type Answer, post } from "./post.ts";

// Team settings (spec, GUI): a tile with the device and its teams, the join requests waiting, and the forms to create a team, invite a computer or an
// unattended device, and join. Every button asks the link holder through /api/link/<name> (control.ts): this page never holds a key, a secret of a team,
// or an invite secret beyond the text it is shown. The roster shows each device's label with its short id beside it, its role, whether it is attended, and
// its last presence; an admin removes, changes a role, and rotates; each other device's trust (reply, forward, dispatch) is set per device. A paired
// device can open this tile and read it, but only this computer's own page changes anything (control.ts REMOTE_LINK).

const POLL_MS = 2000;
type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };
type DetectorClass = new (options: { formats: string[] }) => Detector;
/** The browser's QR reader where there is one (Chrome, Safari on macOS and iOS); Electron on Windows has none, so pasting is a first-class path. */
// SAFETY: BarcodeDetector is not in the DOM typings; the optional chain below treats a missing one as "no camera reading here".
const detectorClass = (): DetectorClass | undefined => (globalThis as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;

const reason = (r: Answer) => r.body.reason ?? m.refused({ status: r.status });
const roleName = (role: string) => (role === "admin" ? m.link_role_admin() : m.link_role_member());
const levelName = (level: string) => ({ reply: m.link_level_reply, forward: m.link_level_forward, dispatch: m.link_level_dispatch })[level as "reply"]();

export function linkTile(): Tile {
	return { id: "link", title: m.link_tile_title(), icon: "i-tower", body: mount };
}

function mount(): HTMLElement {
	const root = h("div", { class: "teams-tile" });
	const status = h("p", { class: "link-status", role: "status" });
	const head = h("div", { class: "link-head" }), requests = h("div", { class: "link-requests" }), teams = h("div", { class: "link-teams" }), invites = h("div", { class: "link-invites" });
	let view: LinkView | undefined, sig = "", prefilled = "";
	/** Each team's invite-by-id form, kept across the rebuilds of the page: whether it is open and what is typed in it. */
	const pinned = new Map<string, { open: boolean; text: string }>();

	/** One request to the holder; the reason of a refusal goes under the buttons. */
	const act = async (name: string, body: Record<string, unknown> = {}): Promise<Answer> => {
		const r = await post(`link/${name}`, body).catch(() => ({ ok: false, status: 0, body: { reason: m.no_answer() } }) as Answer);
		if (!r.ok) status.textContent = reason(r);
		else status.textContent = "";
		void refresh();
		return r;
	};
	const button = (text: string, run: () => void | Promise<unknown>, cls = "later") => {
		const b = h("button", { type: "button", class: cls }, text);
		b.onclick = () => {
			b.disabled = true;
			void Promise.resolve(run()).finally(() => (b.disabled = false));
		};
		return b;
	};
	/** A two-step button for what cannot be undone: the first press asks, the second does it. */
	const sure = (text: string, ask: string, run: () => void | Promise<unknown>) => {
		const b = h("button", { type: "button", class: "later" }, text);
		let armed: ReturnType<typeof setTimeout> | undefined;
		b.onclick = () => {
			if (!armed) {
				b.textContent = ask;
				b.dataset.armed = "true";
				armed = setTimeout(() => ((armed = undefined), (b.textContent = text), delete b.dataset.armed), 5000);
				return;
			}
			clearTimeout(armed);
			armed = undefined;
			b.disabled = true;
			void Promise.resolve(run()).finally(() => ((b.disabled = false), (b.textContent = text), delete b.dataset.armed));
		};
		return b;
	};

	// ---- Invite panel: the QR, its text, and the ten minutes -------------------------------------------------------------------------
	const shown = h("div", { class: "link-invite", hidden: "" });
	let tick: ReturnType<typeof setInterval> | undefined, shownHash = "";
	const hideInvite = () => {
		clearInterval(tick);
		shown.hidden = true;
		shown.replaceChildren();
		shownHash = "";
	};
	const showInvite = (r: Answer, title: string) => {
		const body = r.body as { text?: string; rows?: string[]; expires?: number; hash?: string };
		if (!body.text || !body.rows || !body.expires) return;
		clearInterval(tick);
		shownHash = body.hash ?? "";
		const left = h("b", { class: "link-count" }), text = h("textarea", { readonly: "", rows: "4", "aria-label": m.link_invite_text() }) as HTMLTextAreaElement;
		text.value = body.text;
		const copy = button(m.link_copy(), async () => {
			await navigator.clipboard?.writeText(body.text!).then(() => (status.textContent = m.link_copied()), () => (text.select(), (status.textContent = m.link_copy_failed())));
		});
		const cancel = button(m.link_cancel_invite(), async () => {
			await act("invite-cancel", { hash: body.hash });
			hideInvite();
		});
		const draw = () => {
			const ms = body.expires! - Date.now();
			left.textContent = ms > 0 ? m.link_invite_left({ time: countdown(ms) }) : m.link_invite_lapsed();
			shown.dataset.lapsed = String(ms <= 0);
		};
		draw();
		tick = setInterval(draw, 1000);
		shown.hidden = false;
		shown.replaceChildren(h("h4", null, title), square(body.rows), left, h("p", null, m.link_invite_help()), text, h("div", { class: "devices-acts" }, copy, cancel));
	};

	// ---- Join requests waiting at this computer ---------------------------------------------------------------------------------------
	const requestCard = (r: JoinRequestView) => {
		const card = h("div", { class: "link-request" });
		card.append(h("b", null, r.unattended ? m.link_a_join_unattended({ label: r.label, short: r.short, team: r.teamName }) : m.link_a_join({ label: r.label, short: r.short, team: r.teamName })));
		if (r.unattended) {
			card.append(h("p", null, m.link_unattended_help()), h("div", { class: "devices-acts" }, button(m.link_approve(), () => act("decide", { id: r.id, approve: true })), button(m.link_refuse(), () => act("decide", { id: r.id, approve: false }))));
			return card;
		}
		card.append(h("p", null, m.link_words_help({ label: r.label })));
		const sets = h("div", { class: "link-words" });
		for (const [i, words] of r.sets.entries()) sets.append(button(words.join(" "), () => act("decide", { id: r.id, pick: i }), "later link-set"));
		card.append(sets, h("div", { class: "devices-acts" }, button(m.link_none_match(), () => act("decide", { id: r.id, approve: false }))));
		return card;
	};

	// ---- A team ------------------------------------------------------------------------------------------------------------------
	const memberRow = (t: TeamView, mem: MemberView) => {
		const row = h("tr", { "data-self": String(mem.self), "data-online": String(mem.online) });
		const name = h("td", null, h("b", null, mem.label), " ", h("small", { class: "link-short", title: mem.id }, mem.short), mem.duplicate && h("em", { class: "link-dup" }, m.link_duplicate()), !mem.labelKnown && h("em", { class: "link-dup" }, m.link_label_unknown()), mem.self && h("em", null, m.link_you()));
		const trust = h("select", { "aria-label": m.link_trust_for({ name: mem.label }), title: m.link_trust_help() }) as HTMLSelectElement;
		for (const level of ["reply", "forward", "dispatch"] as const) trust.append(new Option(levelName(level), level, false, level === mem.trust));
		trust.onchange = () => void act("trust", { device: mem.id, level: trust.value });
		const admin = t.self.role === "admin" && !mem.self;
		row.append(
			name,
			h("td", { class: "nw" }, roleName(mem.role)),
			h("td", { class: "nw" }, mem.attended ? m.link_attended() : m.link_unattended()),
			h("td", null, mem.self ? "" : lastSeen(mem.seenAgoMs, mem.online)),
			h("td", null, mem.self ? "" : trust),
			h("td", { class: "link-acts" }, ...nodes(
				admin && mem.attended && button(mem.role === "admin" ? m.link_make_member() : m.link_make_admin(), () => act("role", { team: t.team, device: mem.id, role: mem.role === "admin" ? "member" : "admin" })),
				admin && sure(m.link_remove(), m.link_remove_sure(), () => act("remove", { team: t.team, device: mem.id })),
			)),
		);
		return row;
	};
	const teamCard = (t: TeamView) => {
		const card = h("section", { class: "link-team", "data-status": t.status });
		card.append(h("h3", null, t.name, " ", h("small", null, t.team.slice(0, 6))), h("p", { class: "link-meta" }, `${t.project || m.link_no_project()} · ${t.relay || "?"} · ${t.share === "status" ? m.link_share_status() : m.link_share_presence()} · ${m.link_epoch({ n: String(t.epoch) })}`));
		if (t.status === "stopped") return (card.append(h("p", { class: "link-warn" }, m.link_a_fork({ team: t.name, reason: t.stoppedWhy ?? "" })), sure(m.link_leave(), m.link_leave_sure(), () => act("leave", { team: t.team, force: true }))), card);
		if (t.relayDown) card.append(h("p", { class: "link-warn" }, m.link_a_unreachable({ team: t.name, minutes: "2" })));
		if (t.secondAdmin.length) {
			card.append(h("div", { class: "link-warn" }, h("p", null, m.link_second_admin()), h("div", { class: "devices-acts" }, ...t.secondAdmin.map((id) => {
				const mem = t.members.find((x) => x.id === id)!;
				return button(m.link_make_admin_of({ name: mem.label }), () => act("role", { team: t.team, device: id, role: "admin" }));
			}))));
		}
		const table = h("table", { class: "link-roster" }, h("thead", null, h("tr", null, ...[m.link_col_device(), m.link_col_role(), m.link_col_kind(), m.link_col_seen(), m.link_col_trust(), ""].map((c) => h("th", null, c)))), h("tbody", null, ...t.members.map((x) => memberRow(t, x))));
		const unattended = h("input", { type: "text", maxlength: "26", placeholder: m.link_device_id_placeholder(), "aria-label": m.link_device_id() }) as HTMLInputElement;
		const typed = pinned.get(t.team) ?? { open: false, text: "" };
		unattended.value = typed.text;
		unattended.oninput = () => pinned.set(t.team, { open: !unattendedForm.hidden, text: unattended.value });
		const unattendedForm = h("form", { class: "link-inline", ...(typed.open ? {} : { hidden: "" }) }, unattended, button(m.link_invite_pinned(), () => invite(t, unattended.value.trim()), "go"));
		unattendedForm.onsubmit = (event) => (event.preventDefault(), void invite(t, unattended.value.trim()));
		const acts = h("div", { class: "devices-acts" }, ...nodes(
			button(m.link_invite(), () => invite(t)),
			button(m.link_invite_unattended(), () => void ((unattendedForm.hidden = !unattendedForm.hidden), pinned.set(t.team, { open: !unattendedForm.hidden, text: unattended.value }), unattended.focus())),
			t.self.role === "admin" && sure(m.link_rotate(), m.link_rotate_sure(), () => act("rotate", { team: t.team })),
			sure(m.link_leave(), m.link_leave_sure(), () => act("leave", { team: t.team, force: t.onlyAdmin })),
		));
		card.append(table, acts, unattendedForm);
		return card;
	};
	const invite = async (t: TeamView, forDevice?: string) => {
		const r = await act("invite", { team: t.team, ...(forDevice ? { forDevice } : {}) });
		if (r.ok) showInvite(r, forDevice ? m.link_invite_pinned_title({ device: forDevice.slice(0, 6) }) : m.link_invite_title({ team: t.name }));
	};

	// ---- Create a team ----------------------------------------------------------------------------------------------------------------
	const relayIn = h("input", { type: "url", "aria-label": m.link_relay() }) as HTMLInputElement;
	const tokenIn = h("input", { type: "password", autocomplete: "off", "aria-label": m.link_token() }) as HTMLInputElement;
	const labelIn = h("input", { type: "text", maxlength: "40", "aria-label": m.link_label() }) as HTMLInputElement;
	const shareIn = h("select", { "aria-label": m.link_share() }) as HTMLSelectElement;
	shareIn.append(new Option(m.link_share_status_long(), "status"), new Option(m.link_share_presence_long(), "presence"));
	let createDir = "";
	const createPick = folderPicker({}, (path) => (createDir = path), () => {});
	const createGo = h("button", { type: "button", class: "go" }, m.link_create_go());
	createGo.onclick = () => {
		createGo.disabled = true;
		void act("create", { relay: relayIn.value.trim(), token: tokenIn.value.trim(), project: createDir, share: shareIn.value, ...(labelIn.value.trim() ? { label: labelIn.value.trim() } : {}) }).then((r) => {
			createGo.disabled = false;
			if (!r.ok) return;
			tokenIn.value = ""; // a team token works once
			status.textContent = m.link_created({ name: String(r.body.name) });
			createBox.open = false;
		});
	};
	const createBox = h("details", { class: "link-form" }, h("summary", null, m.link_create_title()), h("p", null, m.link_create_help()), h("label", null, m.link_relay(), relayIn), h("label", null, m.link_token(), tokenIn), h("label", null, m.link_label(), labelIn), h("label", null, m.link_share(), shareIn), h("p", null, m.link_project_pick()), createPick.el, createGo);

	// ---- Join ------------------------------------------------------------------------------------------------------------------------------
	const pasteIn = h("textarea", { rows: "3", placeholder: "strawlink1:…", "aria-label": m.link_paste() }) as HTMLTextAreaElement;
	const joinLabel = h("input", { type: "text", maxlength: "40", "aria-label": m.link_label() }) as HTMLInputElement;
	const joinShare = h("select", { "aria-label": m.link_share() }) as HTMLSelectElement;
	joinShare.append(new Option(m.link_share_status_long(), "status"), new Option(m.link_share_presence_long(), "presence"));
	const joinProgress = h("div", { class: "link-join-progress" });
	let joinDir = "";
	const joinPick = folderPicker({}, (path) => (joinDir = path), () => {});
	const useFolder = button(m.link_use_folder(), async () => {
		if (joinDir) await act("join-project", { project: joinDir, share: joinShare.value });
	}, "go");
	const joinGo = h("button", { type: "button", class: "go" }, m.link_join_go());
	joinGo.onclick = () => {
		joinGo.disabled = true;
		void act("join-start", { text: pasteIn.value.trim(), ...(joinLabel.value.trim() ? { label: joinLabel.value.trim() } : {}) }).then((r) => {
			joinGo.disabled = false;
			if (r.ok && joinDir) void act("join-project", { project: joinDir, share: joinShare.value });
		});
	};
	// A camera where the browser can read a QR itself; Electron on Windows cannot, and there the text is pasted.
	const scanBox = h("div", { class: "link-scan", hidden: "" });
	let stopScan: (() => void) | undefined;
	const scan = button(m.link_scan(), async () => {
		const Detector = detectorClass();
		if (!Detector || !navigator.mediaDevices?.getUserMedia) return;
		if (stopScan) return stopScan();
		const video = h("video", { playsinline: "", muted: "", "aria-label": m.link_scan() }) as HTMLVideoElement;
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
			const detector = new Detector({ formats: ["qr_code"] });
			video.srcObject = stream;
			await video.play();
			scanBox.hidden = false;
			scanBox.replaceChildren(video);
			const timer = setInterval(() => void detector.detect(video).then((found) => {
				const text = found.map((f) => f.rawValue).find((v) => v.trim().startsWith("strawlink1:"));
				if (text) (stopScan?.(), (pasteIn.value = text.trim()));
			}, () => {}), 300);
			stopScan = () => {
				clearInterval(timer);
				for (const track of stream.getTracks()) track.stop();
				scanBox.hidden = true;
				scanBox.replaceChildren();
				stopScan = undefined;
			};
		} catch (error) {
			status.textContent = m.link_camera_failed({ reason: (error as Error).message });
		}
	});
	scan.hidden = !detectorClass();
	const joinBox = h("details", { class: "link-form" }, h("summary", null, m.link_join_title()), h("p", null, m.link_join_help()), pasteIn, scan, scanBox, h("label", null, m.link_label(), joinLabel), h("label", null, m.link_share(), joinShare), h("p", null, m.link_project_pick()), joinPick.el, joinGo, joinProgress);

	const drawJoin = (j: JoinView | undefined) => {
		if (!j) return void joinProgress.replaceChildren();
		const rows = [];
		if (j.state === "failed") rows.push(h("p", { class: "link-warn" }, j.error ?? ""));
		else if (j.state === "done") rows.push(h("p", null, m.link_join_done()));
		else {
			rows.push(h("p", null, m.link_join_words()), h("p", { class: "link-bigwords" }, j.words.join(" ")), h("p", null, j.pinned ? m.link_join_waiting_pinned() : m.link_join_waiting({ time: countdown(j.expires - Date.now()) })));
			if (j.needsProject) rows.push(h("p", null, m.link_join_need_project()), useFolder);
			else rows.push(h("p", null, m.link_join_project_set()));
		}
		if (j.state !== "done") rows.push(button(m.link_join_cancel(), () => act("join-cancel")));
		joinProgress.replaceChildren(...rows);
	};

	// ---- The whole page, from the holder's state --------------------------------------------------------------------------------------
	const setup = () => {
		const go = button(m.link_setup(), async () => {
			const r = await post("link/enable", {}).catch(() => undefined);
			status.textContent = r?.ok ? m.link_setup_wait() : (r ? reason(r) : m.no_answer());
		}, "go");
		head.replaceChildren(h("p", null, m.link_setup_help()), go);
		requests.replaceChildren();
		teams.replaceChildren();
	};
	const draw = (v: LinkView) => {
		view = v;
		// The page is rebuilt only when what it shows changed: a teammate's last presence counts in minutes, so a poll that moved it by seconds leaves a typed field alone.
		const next = JSON.stringify([v.label, v.deviceId, v.relay, v.teams.map((t) => [{ ...t, members: t.members.map((x) => ({ ...x, seenAgoMs: x.seenAgoMs === null ? null : Math.floor(x.seenAgoMs / 60_000) })) }]), v.joinRequests, v.invites, v.alerts.map((a) => a.id)]);
		if (status.textContent === m.link_setup_wait()) status.textContent = "";
		if (shownHash && !v.invites.some((i) => i.hash === shownHash)) hideInvite(); // the invite was used, lapsed, or cancelled
		if (v.join) drawJoin(v.join);
		else joinProgress.replaceChildren();
		if (v.prefill && prefilled !== JSON.stringify(v.prefill)) {
			prefilled = JSON.stringify(v.prefill);
			if (v.prefill.kind === "join") {
				if (v.prefill.text) pasteIn.value = v.prefill.text;
				if (v.prefill.project) void joinPick.picker.go(v.prefill.project);
				joinBox.open = true;
			} else {
				if (v.prefill.relay) relayIn.value = v.prefill.relay;
				if (v.prefill.project) void createPick.picker.go(v.prefill.project);
				if (v.prefill.share) shareIn.value = v.prefill.share;
				createBox.open = true;
			}
			status.textContent = m.link_prefilled({ reason: v.prefill.reason });
			void post("link/prefill-clear", {}).catch(() => {});
		}
		if (!relayIn.value && v.relay) relayIn.value = v.relay;
		joinLabel.placeholder = labelIn.placeholder = v.label;
		if (next === sig) return;
		sig = next;
		head.replaceChildren(h("p", null, h("b", null, v.label), " ", h("small", { class: "link-short", title: v.deviceId }, v.short), " · ", m.link_device_id_is(), " ", h("code", null, v.deviceId)));
		requests.replaceChildren(...v.joinRequests.map(requestCard));
		teams.replaceChildren(...(v.teams.length ? v.teams.map(teamCard) : [h("p", { class: "chat-empty" }, m.link_no_teams())]));
		const open = v.invites.filter((i) => i.hash !== shownHash);
		invites.replaceChildren(...nodes(open.length > 0 && h("h4", null, m.link_open_invites()), ...open.map((i) => {
			const row = h("div", { class: "link-open-invite" }, h("span", null, `${i.teamName}${i.forDevice ? ` · ${i.forDevice.slice(0, 6)}` : ""} · ${countdown(i.expires - Date.now())}`));
			row.append(button(m.link_show(), async () => {
				const r = await act("invite-text", { hash: i.hash });
				if (r.ok) showInvite(r, i.forDevice ? m.link_invite_pinned_title({ device: i.forDevice.slice(0, 6) }) : m.link_invite_title({ team: i.teamName }));
			}), button(m.link_cancel_invite(), () => act("invite-cancel", { hash: i.hash })));
			return row;
		})));
	};
	async function refresh() {
		if (!root.isConnected && view) return;
		const r = await post("link/state", {}).catch(() => undefined);
		if (!r) return;
		// SAFETY: `view` is what the holder's `state` call returns (src/link/holder.ts LinkView) through control.ts, which passes its JSON on unchanged; the page has no schema to check it against.
		if (r.ok) return draw(r.body.view as unknown as LinkView);
		if (r.body.error === "no_holder") return setup();
		status.textContent = reason(r);
	}
	const timer = setInterval(() => (root.isConnected ? void refresh() : clearInterval(timer)), POLL_MS);
	root.append(head, status, requests, teams, shown, invites, createBox, joinBox);
	void refresh();
	return root;
}
