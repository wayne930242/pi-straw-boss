import { setup } from "./isolation.ts";

// Loaded before any test (`node --import ./tests/setup.ts --test ...`, which `npm test` runs), and by fakes.ts and server-world.ts for a test run without the flag: see isolation.ts.
setup();
