// Copied from pi-herdr-agents f1590cb (MIT, Copyright (c) 2026 Giuseppe Rodriguez); see NOTICE.md.
import {
	readPaneAgentSession,
	reportPaneToken,
	type PaneTokenWrite,
} from "./herdr/herdr-socket.ts";
import {
	DELEGATED_MARKER_SOURCE,
	DELEGATED_MARKER_TOKEN,
	DELEGATED_MARKER_VALUE,
	DELEGATED_MARKER_TTL_MS,
	type MarkerWriter,
	type MarkerSessionReader,
} from "@nubl/maestro/runtime/delegated-marker";

export function herdrMarkerWriter(socketPath: string): MarkerWriter {
	return ({ paneId, seq, live }) => {
		const write: PaneTokenWrite = {
			paneId,
			source: DELEGATED_MARKER_SOURCE,
			seq,
			token: DELEGATED_MARKER_TOKEN,
			value: null,
		};
		if (live) {
			write.value = DELEGATED_MARKER_VALUE;
			write.ttlMs = DELEGATED_MARKER_TTL_MS;
		}
		return reportPaneToken(socketPath, write);
	};
}

export function herdrMarkerSessionReader(
	socketPath: string,
): MarkerSessionReader {
	return (paneId) => readPaneAgentSession(socketPath, paneId);
}
