import { EventEmitter } from "node:events";
import type { Broker, Incoming, IntercomLike, Registration } from "../src/agent/kit.ts";
import type { Session } from "../src/herdr.ts";

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
	async connect(_session: Registration, sessionId?: string) {
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
