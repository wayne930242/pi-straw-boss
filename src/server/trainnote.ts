import type { Opened, OpenRequest } from "../opener.ts";
import { type CarBook, openingFacts } from "./carbook.ts";

// What the server reads when the tower opens a train (docs/specs/2026-11-07-train-workers.md §24): the base and the heads of the cars from the manifest the integrator sent, and the project's remote from the tower workspace's checkout, with the remote of each app there that is a repository of its own (a submodule; 0.80.2). All are read BEFORE
// the opener creates the train's tab, so no process of the train can have changed the checkout's configuration yet; they are the only source the `landed` check and a train's right to a car rest on. Nothing is read again later.

type Open = (input: OpenRequest) => Promise<Opened>;
export interface TrainNoteDeps {
	cars: Pick<CarBook, "noteTrain" | "remoteOf" | "appRemotesOf" | "appNamesOf"> | undefined;
	/** The tower workspace's checkout folder, or undefined when it has none. */
	checkout(): Promise<string | undefined>;
	error(what: string, message: string): void;
}

/** The opener, noting each train it opens in the car book. A repeated open (the opener's ledger answers it) is noted without a remote, the project's or an app's: the train may have changed the checkout since, and the book keeps the first note of a code. */
export function noteTrains(open: Open, d: TrainNoteDeps): Open {
	return async (input) => {
		let before: { facts: ReturnType<typeof openingFacts>; url: string | undefined; appUrls: Record<string, string | null>; apps: string[] } | undefined;
		if (input.role === "train" && d.cars) {
			try { const checkout = await d.checkout(); before = { facts: openingFacts(input.request), url: await d.cars.remoteOf(checkout), appUrls: await d.cars.appRemotesOf(checkout), apps: await d.cars.appNamesOf(checkout) }; } catch (cause) { d.error("cars", (cause as Error).message); }
		}
		const opened = await open(input);
		if (opened.train && before) {
			const { facts, url, appUrls, apps } = before;
			try { d.cars?.noteTrain({ project: opened.train.project, code: opened.train.code, session: opened.main, pane: opened.pane, integrator: opened.sender, ...(facts.base ? { base: facts.base } : {}), heads: facts.heads, ...(url && !opened.repeated ? { url } : {}), ...(opened.repeated ? {} : { appUrls, apps }) }); } catch (cause) { d.error("cars", (cause as Error).message); }
		}
		return opened;
	};
}
