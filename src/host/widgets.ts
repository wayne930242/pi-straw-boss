// Copied from pi-herdr-agents f1590cb, with the run-row changes of 2045e55 (branch feat/run-rows-probe; MIT, Copyright (c) 2026 Giuseppe Rodriguez); see NOTICE.md. sb: one row per worker, name · model · state · time.
import type { RunRows } from "./run-rows.ts";
import type { Nudger } from "./nudge.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SupervisionConfig } from "@nubl/maestro/core/config/supervision-config";
import { encodeHostValue } from "@nubl/maestro/core/host-text";
import {
	capStatusLines,
	formatElapsedDuration,
	formatStatusAggregate,
	normalizeStatusName,
	type StatusConfig,
} from "@nubl/maestro/core/status";
import {
	formatLifecycleTransitionLine,
	lifecycleTransition,
	projectLifecycle,
} from "@nubl/maestro/core/lifecycle";
import {
	WIDGET_INTERVAL_KEY,
	STATUS_INTERVAL_KEY,
	writeGlobalSlot,
	type RunningSubagent,
	type SubagentRuntime,
} from "@nubl/maestro/pi/subagents/state";
import {
	type Observation,
	formatNoProgressAdvisoryLine,
} from "@nubl/maestro/pi/subagents/observation";

// ── Widget management ──

function formatElapsedMMSS(startTime: number, endTime = Date.now()): string {
	const seconds = Math.max(0, Math.floor((endTime - startTime) / 1000));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return `${h > 0 ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACTIVE_ACCENT = "\x1b[38;2;77;163;255m";
const OPEN_ACCENT = "\x1b[38;2;214;158;46m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
export function borderLine(
	left: string,
	right: string,
	width: number,
	accent = ACTIVE_ACCENT,
): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}│${RST}`;

	// width = total visible chars for the whole line including │ and │
	const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
	const rightVis = visibleWidth(right);

	// If the status chunk alone is too wide, prefer preserving it in compact form
	// rather than overflowing the terminal.
	if (rightVis >= contentWidth) {
		const truncRight = truncateToWidth(right, contentWidth);
		const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
		return `${accent}│${RST}${truncRight}${" ".repeat(rightPad)}${accent}│${RST}`;
	}

	const maxLeft = Math.max(0, contentWidth - rightVis);
	const truncLeft = truncateToWidth(left, maxLeft);
	const leftVis = visibleWidth(truncLeft);
	const pad = Math.max(0, contentWidth - leftVis - rightVis);
	return `${accent}│${RST}${truncLeft}${" ".repeat(pad)}${right}${accent}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(
	title: string,
	info: string,
	width: number,
	accent = ACTIVE_ACCENT,
): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}╭${RST}`;

	// ╭─ Title ───...─── info ─╮
	// overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
	const inner = Math.max(0, width - 2); // inside ╭ and ╮
	const titlePart = `─ ${title} `;
	const infoPart = ` ${info} ─`;
	const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
	const fill = "─".repeat(fillLen);
	const content = `${titlePart}${fill}${infoPart}`
		.slice(0, inner)
		.padEnd(inner, "─");
	return `${accent}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number, accent = ACTIVE_ACCENT): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}╰${RST}`;

	const inner = Math.max(0, width - 2);
	return `${accent}╰${"─".repeat(inner)}╯${RST}`;
}

function formatLifecycleWidgetLabel(
	projection: ReturnType<typeof projectLifecycle>,
	now: number,
): string {
	const duration =
		projection.stateDurationSince == null
			? ""
			: ` ${formatElapsedDuration(now - projection.stateDurationSince)}`;
	if (projection.kind === "active")
		return projection.label
			? ` active · ${encodeHostValue(projection.label)}${duration} `
			: ` active${duration} `;
	if (projection.kind === "blocked") return ` blocked${duration} `;
	if (projection.kind === "running") return " running… ";
	if (projection.kind === "waiting") return ` waiting${duration} `;
	if (projection.kind === "interrupted") return ` interrupted${duration} `;
	if (projection.kind === "stalled") return ` stalled${duration} `;
	// completed/failed exist as lifecycle projections for delivery bookkeeping,
	// but the row is removed immediately after result delivery — so the only
	// visible terminal handoff label is finalizing.
	if (
		projection.kind === "finalizing" ||
		projection.kind === "completed" ||
		projection.kind === "failed"
	) {
		return " finalizing… ";
	}
	return " starting… ";
}

interface WidgetDeps {
	runtime: SubagentRuntime;
	statusConfig: StatusConfig;
	supervisionConfig: SupervisionConfig;
	observeRunningSubagent: Observation["observeRunningSubagent"];
	evaluateNoProgressAdvisory: Observation["evaluateNoProgressAdvisory"];
}

/** Widget and status refresh timers for one extension instance. */
export function createWidgetController(
	{
		runtime,
		statusConfig,
		supervisionConfig,
		observeRunningSubagent,
		evaluateNoProgressAdvisory,
	}: WidgetDeps,
	presenters = new WeakMap<ExtensionAPI, RunRows>(),
	/** sb's done nudge (nudge.ts): asked about each child at each look; its queued notices ride in the same status message. */
	nudger?: Nudger,
) {
	const runningSubagents = runtime.runningSubagents;

	/** Interval timer for widget re-renders. */
	let widgetInterval: ReturnType<typeof setInterval> | null = null;

	/** Interval timer for status transition checks. */
	let statusInterval: ReturnType<typeof setInterval> | null = null;

	function renderSubagentWidgetLines(
		agents: RunningSubagent[],
		width: number,
		presenter: RunRows | null | undefined = runtime.pi &&
			presenters.get(runtime.pi),
	): string[] {
		const now = Date.now();
		const claimed = presenter?.claimed();
		const visible = agents.filter((a) => !claimed?.has(a.id));
		const hidden = agents.length - visible.length;
		if (hidden && !visible.length) return [];
		const rendered = visible.map((agent) => ({
			agent,
			projection: projectLifecycle(agent.lifecycle, now),
		}));
		const activeCount = rendered.filter(
			({ projection }) =>
				projection.kind === "active" ||
				projection.kind === "starting" ||
				projection.kind === "running" ||
				projection.kind === "blocked",
		).length;
		const openCount = visible.length - activeCount;
		const info =
			activeCount > 0
				? openCount > 0
					? `${activeCount} active · ${openCount} open`
					: `${activeCount} active`
				: `${openCount} open`;
		const accent = activeCount > 0 ? ACTIVE_ACCENT : OPEN_ACCENT;

		const lines: string[] = [
			borderTop(
				"Subagents",
				hidden ? `${info} · ${hidden} on todos` : info,
				width,
				accent,
			),
		];

		for (const { agent, projection } of rendered) {
			const elapsed = formatElapsedMMSS(
				agent.startTime,
				projection.runtimeEndedAt ?? now,
			);
			// sb: one row per worker, name · model · state · time; the name is cut first when the box is narrow.
			const model = agent.runtimePlan
				? ` · ${encodeHostValue(agent.runtimePlan.modelId)}`
				: "";
			const left = ` ${encodeHostValue(agent.name)}`;
			const state =
				agent.cancelState === "unconfirmed"
					? "cancel unconfirmed"
					: agent.cancelState
						? "cancelling…"
						: statusConfig.enabled
							? formatLifecycleWidgetLabel(projection, now).trim()
							: "starting…";
			const right = `${model} · ${state} · ${elapsed} `;

			lines.push(borderLine(left, right, width, accent));
		}

		lines.push(borderBottom(width, accent));
		return lines;
	}

	function updateWidget() {
		const latestCtx = runtime.latestCtx;
		if (!latestCtx?.hasUI) return;

		if (runningSubagents.size === 0) {
			latestCtx.ui.setWidget("subagent-status", undefined);
			if (widgetInterval) {
				clearInterval(widgetInterval);
				widgetInterval = null;
				writeGlobalSlot<ReturnType<typeof setInterval> | null>(
					WIDGET_INTERVAL_KEY,
					null,
				);
			}
			return;
		}

		// A widget can render again after another API becomes live.
		// Maestro's deferred and error-encoding tool APIs inherit from the
		// registered API. Follow that chain, not the last registered runtime.pi.
		let api: ExtensionAPI | null = runtime.liveApi ?? null;
		while (api && !presenters.has(api)) api = Object.getPrototypeOf(api);
		const presenter = api && presenters.get(api);
		latestCtx.ui.setWidget(
			"subagent-status",
			(_tui: any, _theme: any) => {
				return {
					invalidate() {},
					render(width: number) {
						return renderSubagentWidgetLines(
							Array.from(runningSubagents.values()),
							width,
							presenter ?? null,
						);
					},
				};
			},
			{ placement: "aboveEditor" },
		);
	}

	/** The APIs whose `message_start` confirms the done nudge's notices (F009). */
	const watched = new WeakSet<object>();

	function stopStatusRefresh() {
		if (!statusInterval) return;
		clearInterval(statusInterval);
		statusInterval = null;
		writeGlobalSlot<ReturnType<typeof setInterval> | null>(
			STATUS_INTERVAL_KEY,
			null,
		);
	}

	function startStatusRefresh(pi: ExtensionAPI) {
		if (!statusConfig.enabled || statusInterval) return;

		// sb: pi's sendMessage returns before pi takes the message and reports a failure only to its own UI, so a notice leaves the nudger's queue
		// when the message that carries it starts in this session (docs/specs/2026-11-28-done-nudge.md).
		if (nudger && !watched.has(pi)) {
			try {
				pi.on("message_start", (event) => nudger.accepted((event as { message?: unknown }).message));
				watched.add(pi);
			} catch {
				// An API pi already retired: the next start, from a live one, listens.
			}
		}

		// sb: the done nudge's notices go first and outside the line cap; a notice pi has not confirmed goes again while this session is idle.
		const send = (lines: string[], now: number) => {
			let idle = false;
			try {
				idle = runtime.latestCtx?.isIdle() === true;
			} catch {
				// A context gone stale holds no turn we know of: wait for the next one.
			}
			const notices = nudger ? nudger.outbox(now, idle) : [];
			const all = [...notices.map((n) => n.text), ...lines];
			if (all.length === 0) return;
			const limit = statusConfig.lineLimit + notices.length;
			const capped = capStatusLines(all, limit);
			const ids = notices.map((n) => n.id);
			try {
				pi.sendMessage(
					{
						customType: "subagent_status",
						content: formatStatusAggregate(all, limit),
						display: true,
						details: { lines: capped.visibleLines, overflow: capped.overflow, ...(ids.length ? { nudgeNotices: ids } : {}) },
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
			} catch (error) {
				nudger?.unsent(ids);
				throw error;
			}
		};

		const tick = () => {
			const now = Date.now();
			nudger?.prune(runningSubagents.keys(), now);
			if (runningSubagents.size === 0) {
				send([], now);
				// sb: the loop stays while a notice waits for pi's confirmation.
				if (!nudger?.undelivered()) stopStatusRefresh();
				return;
			}

			const transitionLines: string[] = [];
			let shouldRefreshWidget = false;

			for (const running of runningSubagents.values()) {
				// Dual-writes lifecycle + statusState for reload hydration; steers use lifecycle only.
				observeRunningSubagent(running, now);
				const projection = projectLifecycle(running.lifecycle, now);
				const transition = lifecycleTransition(
					running.lastProjectedKind,
					projection.kind,
				);
				if (running.lastProjectedKind !== projection.kind) {
					shouldRefreshWidget = true;
				}
				running.lastProjectedKind = projection.kind;

				// Interactive subagents (long-running, user-driven) intentionally don't
				// wake the parent session on stalled/recovered transitions — the user is
				// working in the subagent's pane, and a steer message here would burn an
				// orchestrator turn on a no-op "still waiting" ping. Widget still updates.
				if (transition && !running.interactive) {
					transitionLines.push(
						formatLifecycleTransitionLine(
							normalizeStatusName(running.name),
							projection,
							transition,
							now,
							running.startTime,
							formatElapsedDuration,
						),
					);
				}

				const noProgress = evaluateNoProgressAdvisory(
					running,
					projection,
					now,
					supervisionConfig.hangWarningMinutes,
				);
				if (noProgress?.notify) {
					transitionLines.push(
						formatNoProgressAdvisoryLine(running, noProgress),
					);
				}

				// sb: a child idle too long without a result is asked to finish (docs/specs/2026-11-28-done-nudge.md).
				nudger?.look(running, projection, now);
			}

			if (shouldRefreshWidget) updateWidget();

			send(transitionLines, now);
		};

		statusInterval = setInterval(() => {
			// sb: a throw here would escape the timer; what it left undone is done at the next tick.
			try {
				tick();
			} catch {
				// Nothing to report to: the next tick tries again, and the nudger kept what was not sent.
			}
		}, 1000);

		writeGlobalSlot(STATUS_INTERVAL_KEY, statusInterval);
	}

	/** sb: after a reload, the notices the last load left unconfirmed go out even when no run is left to start the loop. */
	function resumeNotices(pi: ExtensionAPI) {
		if (nudger?.undelivered()) startStatusRefresh(pi);
	}

	function startWidgetRefresh() {
		if (widgetInterval) return;
		updateWidget(); // immediate first render
		widgetInterval = setInterval(() => {
			updateWidget();
		}, 1000);
		writeGlobalSlot(WIDGET_INTERVAL_KEY, widgetInterval);
	}

	function stopRefresh() {
		if (widgetInterval) {
			clearInterval(widgetInterval);
			widgetInterval = null;
			writeGlobalSlot<ReturnType<typeof setInterval> | null>(
				WIDGET_INTERVAL_KEY,
				null,
			);
		}
		stopStatusRefresh();
		// sb: a reload or a quit revokes the done nudge's open requests (F007); its notices stay in the process-wide store for the next load.
		nudger?.stop(Date.now());
	}

	return {
		renderSubagentWidgetLines,
		updateWidget,
		startStatusRefresh,
		startWidgetRefresh,
		stopRefresh,
		resumeNotices,
	};
}
