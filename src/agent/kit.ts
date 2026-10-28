import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Session } from "../herdr.ts";
import { type Channel, type Config, createKit, type Kit, REGISTER } from "../state.ts";

// A Claude Code or Codex session has no pi, so the modules that run the net (membership, election, guard, presence, reach) get the two things they
// ask pi-intercom's extension for from a raw `IntercomClient`: the channel of a registered namespace, and the outbox. Both mirror pi-intercom's own
// (`index.ts` createExtensionChannel, handleOutboxRequest); a protocol change there can break this file, so the join checks `extension-bus-v1`.
const OUTBOX = "intercom:outbox-request";
const OUTBOX_RESULT = "intercom:outbox-result";
const BUS = "extension-bus-v1";
const NAMESPACE = /^[a-z0-9][a-z0-9._/-]{0,63}$/;

/** The part of pi-intercom's `IntercomClient` the sidecar uses; pi-intercom is a runtime requirement found by path (intercom.ts), not an import. */
export interface Registration { name?: string; cwd: string; model: string; pid: number; startedAt: number; lastActivity: number; status?: string; herdrPaneId?: string; acknowledgesReceipts?: boolean; extensions?: { namespace: string; ownerEligible: boolean }[] }
export type Broker = { type: string } & Record<string, unknown>;
export interface Incoming { id: string; replyTo?: string; content: { text: string; attachments?: { name: string }[] }; crossMachine?: { origin: { name: string; machine: string } } }
export interface IntercomLike {
	readonly sessionId: string | null;
	isConnected(): boolean;
	supportsFeature(feature: string): boolean;
	connect(session: Registration, sessionId?: string): Promise<void>;
	disconnect(): Promise<void>;
	listSessions(options?: { timeoutMs?: number }): Promise<Session[]>;
	send(to: string, options: { text: string; messageId?: string; provenance?: unknown }): Promise<{ id: string; delivered: boolean; reason?: string; code?: string }>;
	updatePresence(updates: { name?: string; status?: string }): void;
	updateExtensionCapabilities(extensions: { namespace: string; ownerEligible: boolean }[]): void;
	sendExtensionMessage(message: Record<string, unknown>): void;
	/** Tells the broker (and the sender) what became of a message: only a receiver registered with `acknowledgesReceipts` is waited for (the sb server's tower identities). */
	sendMessageReceipt?(receipt: { messageId: string; status: "queued" | "receiver_received" | "injected" | "acknowledged" | "expired"; timestamp: number; detail?: string }): void;
	onBrokerMessage(handler: (message: Broker) => void): () => void;
	on(event: "message", listener: (from: Session, message: Incoming) => void): unknown;
	on(event: "disconnected" | "error", listener: (error: Error) => void): unknown;
}

type Event = Record<string, unknown> & { type: string };
type Owner = { sessionId: string; epoch: string };
interface Local { registration: { namespace: string; ownerEligible: boolean; onEvent(event: Event): void; onReady(channel: Channel): void }; owner?: Owner; state?: { revision: number; payload: unknown } }
interface Outbox { version?: unknown; requestId?: unknown; extensionId?: unknown; extensionName?: unknown; to?: unknown; message?: unknown }
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** The kit of a net sidecar: `pi` is the event bus and nothing else (any other member throws), and `attach` points it at the broker connection, again after each reconnect. */
export type HeadlessKit = Kit & { attach(client: IntercomLike): void; extensions(): { namespace: string; ownerEligible: boolean }[] };
export function createHeadlessKit({ client, env, cfg, log = () => {} }: { client: IntercomLike; env: NodeJS.ProcessEnv; cfg: Config; log?: (text: string, level?: "info" | "warning" | "error") => void }): HeadlessKit {
	const handlers = new Map<string, Set<(data: unknown) => void>>(), locals = new Map<string, Local>(), pending = new Set<string>(), used = new Set<string>();
	let current = client, off: (() => void) | undefined;
	const events = {
		on: (channel: string, handler: (data: unknown) => void) => {
			handlers.set(channel, (handlers.get(channel) ?? new Set()).add(handler));
			return () => void handlers.get(channel)?.delete(handler);
		},
		emit: (channel: string, data: unknown) => [...(handlers.get(channel) ?? [])].forEach((handler) => handler(data)),
	};
	const pi = new Proxy({ events }, { get: (target, key) => { if (key in target) return target[key as "events"]; if (typeof key === "symbol") return undefined; throw new Error(`pi.${String(key)} is not available in a net sidecar`); } }) as unknown as ExtensionAPI;
	const kit = { ...createKit(pi, { ...cfg, env }), tell: log };
	const extensions = () => [...locals.values()].map(({ registration: { namespace, ownerEligible } }) => ({ namespace, ownerEligible }));
	const emitLocal = (namespace: string, event: Event) => {
		try { locals.get(namespace)?.registration.onEvent(event); } catch { /* one namespace must not break another */ }
	};
	const channel = (namespace: string): Channel => ({
		snapshot: () => ({ connected: current.isConnected(), supported: current.supportsFeature(BUS), ...(locals.get(namespace)?.owner ? { owner: locals.get(namespace)!.owner } : {}), ...(locals.get(namespace)?.state ? { state: locals.get(namespace)!.state } : {}) }),
		publish(payload, options = {}) {
			if (!current.isConnected()) throw new Error("Intercom is not connected");
			current.sendExtensionMessage({ type: "extension_publish", namespace, audience: options.audience ?? "owner", payload });
		},
		commitState(payload, expectedRevision) {
			if (!current.isConnected()) throw new Error("Intercom is not connected");
			const local = locals.get(namespace);
			if (!local?.owner || local.owner.sessionId !== current.sessionId) throw new Error(`Current session is not the owner of ${namespace}`);
			current.sendExtensionMessage({ type: "extension_state_commit", namespace, ownerEpoch: local.owner.epoch, expectedRevision: expectedRevision ?? local.state?.revision ?? 0, payload });
		},
		listSessions: () => {
			if (!current.isConnected()) return Promise.reject(new Error("Intercom is not connected"));
			return current.listSessions();
		},
	});
	events.on(REGISTER, (data) => {
		const registration = data as Local["registration"];
		if (!NAMESPACE.test(registration.namespace)) throw new Error(`Invalid intercom extension namespace: ${registration.namespace}`);
		if (locals.has(registration.namespace)) throw new Error(`Intercom extension namespace already registered: ${registration.namespace}`);
		const local: Local = { registration };
		locals.set(registration.namespace, local);
		const [connected, supported] = [current.isConnected(), current.supportsFeature(BUS)];
		if (connected && supported) current.updateExtensionCapabilities(extensions());
		registration.onReady(channel(registration.namespace));
		if (connected) emitLocal(registration.namespace, { type: "connection", connected: true, supported });
	});
	const answer = (request: { requestId: string; extensionId?: string; extensionName?: string }, status: string, more: { code?: string; detail?: string; messageId?: string } = {}) =>
		events.emit(OUTBOX_RESULT, { version: 1, requestId: request.requestId, status, ...(request.extensionId ? { extensionId: request.extensionId } : {}), ...(request.extensionName ? { extensionName: request.extensionName } : {}), ...more });
	/** The result of a request in flight, once. */
	const settle = (request: { requestId: string; extensionId?: string; extensionName?: string }, status: string, more: { code?: string; detail?: string; messageId?: string } = {}) => pending.delete(request.requestId) && answer(request, status, more);
	events.on(OUTBOX, (data) => {
		const r = (typeof data === "object" && data !== null ? data : {}) as Outbox;
		const [requestId, extensionId, extensionName, to, message] = [text(r.requestId), text(r.extensionId), text(r.extensionName), text(r.to), typeof r.message === "string" && r.message.trim() ? r.message : undefined];
		const trace = { requestId: requestId ?? "", extensionId, extensionName };
		const reject = (detail: string) => requestId && answer(trace, "rejected", { code: "invalid_request", detail });
		if (r.version !== 1) return void reject("version must be 1");
		if (!requestId || !extensionId || !extensionName || !to || !message) return void reject("requestId, extensionId, extensionName, to, and message are required");
		if (used.has(requestId)) return void answer(trace, "rejected", { code: "duplicate_request", detail: "requestId has already been used in this sidecar" });
		used.add(requestId);
		pending.add(requestId);
		void (async () => {
			const active = current;
			try {
				if (!active.isConnected() || !active.sessionId) return settle(trace, "failed", { code: "session_unavailable", detail: "Intercom is not connected" });
				const sessions = await active.listSessions();
				const byId = sessions.find((x) => x.id === to), byName = byId ? [] : sessions.filter((x) => x.name?.toLowerCase() === to.toLowerCase());
				const matches = byId ? [byId] : byName.length ? byName : sessions.filter((x) => x.id.startsWith(to));
				if (!matches.length) return settle(trace, "blocked", { code: "target_not_found", detail: `Session "${to}" is not currently connected.` });
				if (matches.length > 1) return settle(trace, "blocked", { code: "target_ambiguous", detail: `Multiple sessions match "${to}".` });
				if (matches[0]!.id === active.sessionId) return settle(trace, "blocked", { code: "self_target", detail: "Cannot message the current session." });
				const sent = await active.send(matches[0]!.id, { messageId: requestId, text: message, provenance: { type: "extension_outbox", extensionId, extensionName, requestId } });
				settle(trace, sent.delivered ? "sent" : "failed", sent.delivered ? { messageId: sent.id } : { code: "delivery_failed", messageId: sent.id, detail: sent.reason ?? "Delivery failed" });
			} catch (error) {
				settle(trace, "failed", { code: "session_unavailable", detail: (error as Error).message });
			}
		})();
	});
	const down = () => {
		for (const [namespace, local] of locals) {
			local.owner = undefined;
			emitLocal(namespace, { type: "connection", connected: false, supported: false });
			emitLocal(namespace, { type: "owner" });
		}
		for (const requestId of [...pending]) settle({ requestId }, "failed", { code: "session_unavailable", detail: "Intercom disconnected" });
	};
	const toAll = (event: Event) => [...locals.keys()].forEach((namespace) => emitLocal(namespace, event));
	const onBroker = (message: Broker) => {
		const m = message as Record<string, unknown> & { namespace?: string };
		const local = locals.get(String(m.namespace));
		switch (message.type) {
			case "registered": {
				const supported = Array.isArray(m.features) && m.features.includes(BUS);
				if (supported && locals.size) current.updateExtensionCapabilities(extensions());
				return toAll({ type: "connection", connected: true, supported });
			}
			case "extension_owner":
				if (!local) return;
				local.owner = m.ownerId && m.ownerEpoch ? { sessionId: String(m.ownerId), epoch: String(m.ownerEpoch) } : undefined;
				return emitLocal(m.namespace!, { type: "owner", ...(local.owner ? { owner: local.owner } : {}) });
			case "extension_message":
				return local && emitLocal(m.namespace!, { type: "message", fromSessionId: m.fromSessionId, ...(m.ownerId && m.ownerEpoch ? { owner: { sessionId: m.ownerId, epoch: m.ownerEpoch } } : {}), payload: m.payload });
			case "extension_state":
				if (!local) return;
				local.state = { revision: Number(m.revision), payload: m.payload };
				return emitLocal(m.namespace!, { type: "state", state: local.state });
			case "extension_state_result":
				return local && emitLocal(m.namespace!, { type: "state_result", committed: m.committed, revision: m.revision, ...(m.reason ? { reason: m.reason } : {}) });
			case "session_joined": case "session_left": case "presence_update":
				return toAll(message);
		}
	};
	return {
		...kit,
		extensions,
		attach(next) {
			off?.();
			current = next;
			const stop = next.onBrokerMessage((message) => current === next && onBroker(message));
			next.on("disconnected", () => current === next && down());
			off = stop;
		},
	};
}
