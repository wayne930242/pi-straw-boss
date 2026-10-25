import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LinkStore } from "../../src/link/store.ts";

// A child of the store's cross-process lock test: N read-modify-write rounds on a counter file, each under link/holder.lock, with a pause
// inside the lock so an unlocked version would lose updates.
const [dir, rounds] = [process.argv[2]!, Number(process.argv[3])];
const store = new LinkStore(dir);
store.ensure();
const counter = join(dir, "counter.txt");
for (let i = 0; i < rounds; i++) {
	await store.withLock(async () => {
		const n = Number(readFileSync(counter, "utf8"));
		await new Promise((r) => setTimeout(r, 2));
		writeFileSync(counter, String(n + 1));
	});
}
