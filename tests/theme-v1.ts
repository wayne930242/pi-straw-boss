// §7.1: the published v1 floor, independent of the CSS and contract.json. An additive
// change need not change the version; add its names here when they become promises.
export const words = (s: string) => s.trim().split(/\s+/);
export const v1 = {
	tokens: words(`bg bg-2 surface-0 surface-1 raised sunken well panel plate plate-hi line-c line text dim ink hi tint glow scrim err-text accent accent-hi working amber violet idle ok err err-soft unknown gold shadow paper-hi paper paper-ink paper-edge term-bg term-fg
		ansi-0 ansi-1 ansi-2 ansi-3 ansi-4 ansi-5 ansi-6 ansi-7 ansi-8 ansi-9 ansi-10 ansi-11 ansi-12 ansi-13 ansi-14 ansi-15 aura-1 aura-2 grid sans mono pbs-bg pbs-fg pbs-muted pbs-surface pbs-line pbs-control pbs-accent pbs-on-accent pbs-note pbs-ok pbs-warn pbs-risk pbs-radius pbs-gap pbs-font pbs-font-display pbs-mono pbs-font-size`).map(t => `--${t}`),
	classes: words(`absent act active age alerts ally ally-chip ally-unit ask ask-cancel ask-head ask-opt ask-own ask-send au-dot au-mdot auto-back ava
		badge banner bar bar-acts bar-more base bases big board-acts board-allies board-ally board-ally-cap board-cap board-line board-mark board-mini board-none board-now board-pause board-row board-state board-supply board-supply-row board-unit boss-flag box-ended brand bubble
		card chat-list chat-root chat-scroll cmp-alt cmp-row cmp-send comms-head comms-in composer connect connect-ring conv-cap conv-now credit crumbs current d-doc d-doc-ico deploy-fill deploy-title dialog dot drawer drawer-head dstate foot ghost go head head-btn head-name head-node hud hud-pop in joined later left legend line link link-alert link-team logo
		map modes more name new-base note notice offline on packet pad-key pair-btn pair-tabs panel pcol perch perch-turn pitem plate portrait pulse queue-act queue-bar queue-list quit-btn remote ring rule set-group set-row sheet sheet-yes squad stage stale stats subs supply-barracks supply-cell supply-cells supply-chip supply-cols supply-fog supply-free supply-gate supply-head supply-icon supply-kind supply-name supply-points supply-ready supply-slot supply-tray supply-waiting sweep sys
		tab tab-add tab-btn tally target-btn target-chev target-find target-list target-veil tcard term-bar term-hold term-kb term-typing thought tile title tl-lanes tl-mark tmem-body tmem-counts tmem-empty tmem-ended tmem-note tmem-text todo tog token tower tower-conv tower-notes tower-notices tstate tx tx-body tx-copy unit view-pick work yard yard-chip yard-chip-btn yard-code yard-open yard-pill yard-row yard-title you zen-enter`),
	ids: words("stage work session-view lan-wait"), markProperties: words("--c --c1 --c4"),
	reservedPseudo: words(".base::after .dialog::after .head-node::after .chat-list::after .comms-head::after"),
	parts: words("sprite nouns sentences mount"), slots: [], manifest: words("contract color phases badge senders ambience sounds soundPeaks"),
	attributes: {
		"data-view": words("standard geek raven storybook zen map head workspace session settings"), "data-phase": words("day night"), "data-calm": [""], "data-stale": ["true", "false", ""],
		"data-mark": words("working commanding waiting idle done error unknown"), "data-activity": words("working commanding waiting error"), "data-kind": words("thinking tool monitoring"), "data-sender": ["<role-or-kind-icon>"],
		"data-role": words("tower main member subagent train outside outpost ally run"), "data-state": words("<writer-defined> off on offline replaced error done"), "data-key": ["<item-id>"], "data-vary": words("0 1 2 3 4 5 6 7"),
		"data-status": words("running stopped ended waiting stale unreadable forming departing refused"), "data-level": words("info warning error"), "data-train-wait": [""], "data-under": [""], "data-supply": [""], "data-on": [""], "data-news": [""], "data-head": [""], "data-current": [""], "data-docs": ["<positive-count>"], "data-focus": words("true false"), "data-box": words("live unreachable ended"),
		"aria-selected": words("true false"), "aria-pressed": words("true false"), "aria-checked": words("true false"), "aria-current": ["", "page", "true", "false"], open: [""], hidden: [""], type: ["<html-input-type>"],
	},
	containment: {
		facts: { ".tx": "content-visibility: auto", ".dossier:not(.full)": "content-visibility: hidden", ".head-node": "container-type: inline-size", ".hud": "backdrop-filter: <non-none>" },
		ancestors: words("body .shell .stage #stage #work #session-view .comms-in .composer-root"), fixed: words(".comms-in .dossier.full .target-veil .drawer .drawer-veil .dock .minimap .connect"),
	},
};
