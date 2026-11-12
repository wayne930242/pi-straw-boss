// The reader's words for the lifecycle chart (Lifecycle.cfg: no restart, no day passing, one slip): where the car is, and whether somebody was told of its newest state.
export const title = "a car's life while the sb server stays up";

const TOLD = { due: ", telling its coordinator", retrying: ", telling its coordinator", escalated: ", told", told: ", told", none: "" };
const ENDED = { returned: "Returned by the integrator", dropped: "Dropped by the train", landed: "Landed" };

export function state(v) {
	if (v.slips === 0) return "No slip yet";
	if (v.book === "received") {
		if (v.train === "open") return v.merged ? "On a train, merged to the base" : "On a train";
		return `Received${TOLD[v.notice]}`;
	}
	if (v.book !== "none") return `${ENDED[v.book]}${TOLD[v.notice]}`;
	if (v.towerHas) return "Slip waits at the tower";
	if (v.integ === "slip") return v.fwd === "held" ? "Slip with the integrator" : "Slip with the integrator, but the server holds no forward of it";
	return "The integrator handed the slip back";
}

const STEPS = {
	CoordSends: "the coordinator sends the car's slip to the tower",
	TowerForwards: "the tower forwards the slip to the integrator",
	IntegReceives: "the integrator sets the car received",
	IntegReturns: "the integrator returns the car",
	IntegAsksResend: "sb refuses the integrator; the integrator asks the coordinator, or the tower, to have the slip sent again",
	IntegCallsTower: "sb refuses the integrator; the integrator asks the coordinator, or the tower, to have the slip sent again",
	TrainOpens: "the tower opens a train with the car",
	TrainMerges: "the train merges the car to the base",
	TrainLands: "the train sets the car landed",
	TrainDrops: "the train drops the car",
	NoticeDelivered: "the coordinator gets the notice, or the tower is told in its place",
	TowerToldInstead: "the coordinator gets the notice, or the tower is told in its place",
	ForwardPushedOut: "512 newer forwards push this one out of the server",
};

export const step = (action) => STEPS[action] ?? null;
