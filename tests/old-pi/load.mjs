// usage: node load.mjs <pi surface> <state dir> <socket> — loads src/trust/ask.ts against an older pi's export surface and runs registerTrust; prints OK or the error
import { createJiti } from "../../node_modules/jiti/lib/jiti.mjs";
import { resolve } from "node:path";
const [surface, dir, sock] = process.argv.slice(2);
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": resolve(import.meta.dirname, surface) }, moduleCache: false });
const m = await jiti.import(resolve(import.meta.dirname, "../../src/trust/ask.ts"));
const stdin = { isTTY: true, isRaw: false, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };
const handlers = {};
let reads = 0;
m.registerTrust({ on: (t, h) => void (handlers[t] = h) }, { cfg: { env: { HERDR_SOCKET_PATH: sock }, now: Date.now, sleep: async () => {}, startRead: { later: async () => void reads++ } }, guiDir: dir }, { stdin, proc: process, write() {} });
const decision = await handlers.project_trust({ cwd: process.cwd() }, { mode: "tui", hasUI: true });
console.log(`OK reads=${reads} decision=${decision.trusted}`);
process.exit(0);
