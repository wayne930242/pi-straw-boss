// The reader's words for the lifecycle chart (Lifecycle.cfg: no restart, no day passing, two slips, and nothing going wrong on the way): where the car is, whether its coordinator was told of its newest state, and what a slip sent again starts.
export const title = "a car's life while the sb server stays up";

const TOLD = { due: ", telling its coordinator", retrying: ", telling its coordinator", escalated: ", told", told: ", told", none: "" };
const ENDED = { returned: "Returned by the integrator", dropped: "Dropped by the train", landed: "Landed" };

export function state(v) {
	if (v.slips === 0) return "No slip yet";
	if (v.book === "received") {
		if (v.train === "open") return v.merged ? "On a train, merged to the base" : "On a train";
		return `Received${TOLD[v.notice]}`;
	}
	if (v.book !== "none") return `${ENDED[v.book]}${TOLD[v.notice]}${v.towerHas ? "; the same head waits at the tower" : v.integ === "slip" ? "; the integrator holds the same head again" : ""}`;
	if (v.towerHas) return "Slip waits at the tower";
	return "Slip with the integrator";
}

const STEPS = {
	CoordSends: "the coordinator sends the car's slip to the tower",
	CoordSendsAgain: "the coordinator sends the same head again",
	TowerForwards: "the tower forwards the slip to the integrator",
	TrainOpens: "the tower opens a train with the car",
	TrainMerges: "the train merges the car to the base",
	TrainLands: "the train sets the car landed",
	TrainDrops: "the train drops the car",
	NoticeDelivered: "the coordinator gets the notice",
};

export function step(action, from) {
	if (action === "IntegReceives") return ENDED[from.book] ? "the integrator sets the car received: a new life" : "the integrator sets the car received";
	if (action === "IntegReturns") return from.merged || from.book === "landed" ? "sb refuses to receive a car that is on the base already, and the integrator returns it with that word" : ENDED[from.book] ? "the integrator returns the car: a new life" : "the integrator returns the car";
	return STEPS[action] ?? null;
}
