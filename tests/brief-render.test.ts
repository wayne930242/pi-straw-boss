import assert from "node:assert/strict";
import { test } from "node:test";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { World } from "./fakes.ts";

test("a role steer renders as one line until expanded; a tower digest keeps pi's renderer", async () => {
	const w = new World();
	try {
		const a = w.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
		await a.start();
		await a.run();
		await a.promote();
		const steer = a.sent.find((m) => m.customType === "straw-boss")!;
		assert.match(steer.content, /^<straw-boss>[\s\S]*## Seam bindings[\s\S]*<\/straw-boss>$/);
		const renderer = a.renderers.get(steer.customType);
		assert.ok(renderer, "role renderer registered by sb, independent of subagent host");
		setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: ["ctrl+o"], description: "Expand" } }));
		const theme = { fg: (_: string, text: string) => text } as never;
		const msg = { ...steer, role: "custom" as const, display: true, timestamp: 0 };
		const view = (expanded: boolean, width: number) => renderer(msg, { expanded, outputPad: 1 }, theme)!.render(width).map((l) => l.trim());
		const lines = steer.content.split("\n");
		assert.deepEqual(view(false, 100), [`[straw-boss] role: main · coordinator (${lines.length} lines, ctrl+o to expand)`]);
		assert.equal(view(false, 24).length, 1);
		assert.deepEqual(view(true, 2048), lines.map((l) => l.trim()));
		assert.equal(renderer({ ...msg, content: "Since your last run:", details: undefined }, { expanded: false, outputPad: 0 }, theme), undefined);
	} finally { await w.stopAll(); }
});
