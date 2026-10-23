import { EventEmitter } from "node:events";
import type { Broker, Incoming, IntercomLike, Registration as Hello } from "../src/agent/kit.ts";
import type { Session } from "../src/herdr.ts";
import type { FakeBroker, Peer, Registration } from "./fakes.ts";

/** The raw `IntercomClient` as the kit sees it, with a broker that is the test: it injects the broker's messages and records the frames the kit writes. */
export class StubClient extends EventEmitter implements IntercomLike {
	sessionId: string | null = "claude-aaaa";
	connected = true;
	features = new Set(["extension-bus-v1"]);
	sessions: Session[] = [];
	capabilities: { namespace: string; ownerEligible: boolean }[][] = [];
	frames: Record<string, unknown>[] = [];
	sent: { to: string; text: string; messageId?: string }[] = [];
	deliver: { delivered: boolean; reason?: string } = { delivered: true };
	private taps = new Set<(message: Broker) => void>();
	isConnected = () => this.connected;
	supportsFeature = (feature: string) => this.connected && this.features.has(feature);
	async connect(_session: Hello, sessionId?: string) {
		this.sessionId = sessionId ?? "x";
		this.connected = true;
		this.broker({ type: "registered", sessionId: this.sessionId, features: [...this.features] });
	}
	async disconnect() {
		this.connected = false;
		this.emit("closed");
	}
	listSessions = async () => this.sessions;
	async send(to: string, options: { text: string; messageId?: string }) {
		this.sent.push({ to, text: options.text, messageId: options.messageId });
		return { id: options.messageId ?? "m", ...this.deliver };
	}
	updatePresence = (updates: { name?: string }) => void this.frames.push({ type: "presence", ...updates });
	updateExtensionCapabilities = (extensions: { namespace: string; ownerEligible: boolean }[]) => void this.capabilities.push(extensions);
	sendExtensionMessage = (message: Record<string, unknown>) => void this.frames.push(message);
	onBrokerMessage(handler: (message: Broker) => void) {
		this.taps.add(handler);
		return () => void this.taps.delete(handler);
	}
	/** The broker says something to this client. */
	broker(message: Broker) {
		[...this.taps].forEach((handler) => handler(message));
	}
	incoming(from: Session, message: Incoming) {
		this.emit("message", from, message);
	}
	drop(error = new Error("closed")) {
		this.connected = false;
		this.emit("disconnected", error);
	}
}

/**
 * An `IntercomClient` that talks to the `FakeBroker` the pi `Agent`s use: a net sidecar and a pi in one tab share the broker's election, state, and roster.
 * The broker hands the pi-intercom extension API (events already named), so this translates them back to the broker messages the real client emits.
 */
export class FakeClient extends EventEmitter implements IntercomLike {
	sessionId: string | null = null;
	connected = false;
	private taps = new Set<(message: Broker) => void>();
	private channels = new Map<string, { publish(payload: unknown, options?: { audience?: string }): void; commitState(payload: unknown): void }>();
	private peer: Peer;
	private broker: FakeBroker;
	constructor(broker: FakeBroker, pane: string) {
		super();
		this.broker = broker;
		this.peer = { id: "", name: "", pane, regs: new Map(), receive: (from, text, id) => void this.emit("message", from, { id, content: { text } }) };
	}
	isConnected = () => this.connected;
	/** A broker older than the extension bus answers no `extension-bus-v1`. */
	bus = true;
	supportsFeature = (feature: string) => this.connected && this.bus && feature === "extension-bus-v1";
	async connect(session: Hello, sessionId?: string) {
		this.sessionId = this.peer.id = sessionId ?? "fake";
		this.peer.name = session.name ?? "";
		this.connected = true;
		this.broker.connect(this.peer);
		this.broker_({ type: "registered", sessionId: this.sessionId, features: this.bus ? ["extension-bus-v1"] : [] });
	}
	async disconnect() {
		if (!this.connected) return;
		this.connected = false;
		this.broker.disconnect(this.peer);
		this.sessionId = null;
	}
	/** The broker hands this client a message, as it does one a session sent. */
	incoming(from: Session, message: Incoming) {
		this.emit("message", from, message);
	}
	/** The broker goes away under the client, as a crash does. */
	drop() {
		if (!this.connected) return;
		this.connected = false;
		this.broker.disconnect(this.peer);
		this.sessionId = null;
		this.emit("disconnected", new Error("closed"));
	}
	listSessions = async () => (await this.broker.sessionList()) as unknown as Session[];
	async send(to: string, options: { text: string; messageId?: string }) {
		const target = this.broker.sessions.get(to);
		if (!target) return { id: options.messageId ?? "m", delivered: false, reason: `Session ${to} is not connected` };
		this.broker.delivered.push({ from: this.peer.id, to, message: options.text, tokens: "" });
		target.receive?.({ id: this.peer.id, name: this.peer.name }, options.text, options.messageId ?? "m");
		return { id: options.messageId ?? "m", delivered: true };
	}
	updatePresence(updates: { name?: string }) {
		if (updates.name !== undefined) this.peer.name = updates.name;
	}
	updateExtensionCapabilities(extensions: { namespace: string; ownerEligible: boolean }[]) {
		for (const { namespace, ownerEligible } of extensions) {
			if (this.peer.regs.has(namespace)) continue;
			const first = this.peer.regs.size === 0;
			this.broker.register(this.peer, {
				namespace,
				ownerEligible,
				onReady: (channel) => this.channels.set(namespace, channel as never),
				onEvent: (event) => this.translate(namespace, event, first),
			});
			// As the real broker answers a capability update: the namespace's owner now, and its state if it has one.
			const owner = this.broker.ownerOf(namespace), state = this.broker.states.get(namespace);
			setImmediate(() => {
				this.broker_({ type: "extension_owner", namespace, ...(owner ? { ownerId: owner.sessionId, ownerEpoch: owner.epoch } : {}) });
				if (state) this.broker_({ type: "extension_state", namespace, revision: state.revision, payload: state.payload });
			});
		}
	}
	sendExtensionMessage(message: Record<string, unknown>) {
		const channel = this.channels.get(String(message.namespace));
		if (message.type === "extension_publish") channel?.publish(message.payload, { audience: String(message.audience) });
		else channel?.commitState(message.payload);
	}
	onBrokerMessage(handler: (message: Broker) => void) {
		this.taps.add(handler);
		return () => void this.taps.delete(handler);
	}
	private broker_(message: Broker) {
		[...this.taps].forEach((handler) => handler(message));
	}
	private translate(namespace: string, event: Record<string, unknown>, first: boolean) {
		const owner = event.owner as { sessionId: string; epoch: string } | undefined;
		if (event.type === "owner") this.broker_({ type: "extension_owner", namespace, ...(owner ? { ownerId: owner.sessionId, ownerEpoch: owner.epoch } : {}) });
		else if (event.type === "message") this.broker_({ type: "extension_message", namespace, fromSessionId: event.fromSessionId, ...(owner ? { ownerId: owner.sessionId, ownerEpoch: owner.epoch } : {}), payload: event.payload });
		else if (event.type === "state") this.broker_({ type: "extension_state", namespace, revision: (event.state as { revision: number }).revision, payload: (event.state as { payload: unknown }).payload });
		else if (event.type === "session_left" && first) this.broker_({ type: "session_left", sessionId: event.sessionId });
	}
}
