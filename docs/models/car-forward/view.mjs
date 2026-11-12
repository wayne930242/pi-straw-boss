// The reader's words for the full check (CarForward.cfg): what the server holds of the car, where its slip is, and what its coordinator and the tower were told.
export const title = "one car, from its coordinator's slip to what the coordinator learns of it";

const NOTICE = { due: ", notice going out", retrying: ", notice not delivered yet", escalated: ", tower told in the coordinator's place", told: "", none: "" };
const ENDED = { returned: "Returned by the integrator", dropped: "Dropped by the train", landed: "Landed" };

function car(v) {
	if (v.slips === 0) return "No slip yet";
	if (v.book === "received") {
		if (v.notice === "due" || v.notice === "retrying") return `Received${NOTICE[v.notice]}`;
		if (v.train === "open") return v.merged ? "On a train, merged to the base" : "On a train";
		return "Received";
	}
	if (v.book !== "none") return `${ENDED[v.book]}${NOTICE[v.notice]}`;
	if (v.integ === "slip" || v.integ === "waits") return v.fwd !== "held" ? "Slip with the integrator, but the server holds no forward of it" : v.merged ? "Slip with the integrator, its head on the base already" : "Slip with the integrator";
	if (v.train === "forgotten") return "The server holds nothing of the car; its train still runs";
	if (v.train === "blocked") return "The server holds nothing of the car; its train is blocked";
	if (v.integ === "done") return "The server holds nothing of the car; the integrator is done with it";
	if (v.towerHas) return "Slip waits at the tower";
	return "The integrator handed the slip back";
}

const KNOWS = { nothing: "coordinator waits for an answer", received: "coordinator was told received", returned: "coordinator was told returned", dropped: "coordinator was told dropped", landed: "coordinator was told landed", resend: "coordinator was asked to send again" };

export function state(v) {
	const parts = [car(v)];
	if (v.towerHas && parts[0] !== "Slip waits at the tower") parts.push("another slip waits at the tower");
	if (v.integ === "slip" && ENDED[v.book]) parts.push("the integrator holds a new slip of it");
	if (v.intWaits) parts.push("the integrator's session waits for the returned notice");
	if (v.slips > 0) parts.push(`${v.toldLanded > 1 ? "coordinator was told landed twice" : KNOWS[v.knows]}${v.coord === "away" ? " (its session is not live)" : ""}`);
	if (v.towerTold) parts.push("tower told");
	return parts.join("; ");
}

const STEPS = {
	CoordSendsAgain: "the coordinator sends the same head again",
	CoordLeaves: "the coordinator's session goes away",
	CoordReturns: "the coordinator's session comes back",
	TowerForwards: "the tower forwards the slip to the integrator",
	IntegAsksResend: "sb refuses the integrator and names the restart; the integrator asks the coordinator to send again",
	IntegCallsTower: "sb refuses the integrator; the integrator calls the tower",
	IntegSeesTold: "the integrator's session sees that the returned notice was told",
	IntegSeesAnswered: "the integrator's session sees that the slip sent again was answered",
	IntegFindsNothing: "the integrator's session finds that the server holds nothing of the car, and calls the tower",
	IntegEndsWaiting: "the integrator's session ends while it waits, and hands the notice to the tower",
	TrainOpens: "the tower opens a train with the car",
	TrainMerges: "the train merges the car to the base",
	TrainLands: "the train sets the car landed",
	TrainDrops: "the train drops the car",
	TrainEnds: "the train ends",
	TrainBlocked: "sb refuses the train it forgot; the train calls the tower",
	NoticeDelivered: "the coordinator gets the notice",
	SendFails: "the notice is not delivered at the first send",
	TowerToldInstead: "sb tells the tower in the coordinator's place",
	Restart: "the sb server restarts",
	DayPasses: "a day passes",
	ForwardPushedOut: "512 newer forwards push this one out of the server",
};

export function step(action, from, to) {
	if (action === "CoordSends") return to.named === "other" ? "the coordinator sends a slip that names another session" : "the coordinator sends the car's slip to the tower";
	if (action === "IntegReceives") return ENDED[from.book] ? "the integrator sets the car received, in a new life" : "the integrator sets the car received";
	if (action === "IntegReturns") return from.merged || from.book === "landed" ? "sb refuses to receive a car that is on the base already; the integrator returns it with that word" : ENDED[from.book] ? "the integrator returns the car, in a new life" : "the integrator returns the car";
	return STEPS[action];
}

export const group = (v) => (v.slips === 0 ? "start" : v.book === "none" && v.restarts > 0 ? "after a restart" : v.book === "none" ? "slip" : v.book === "received" ? "riding" : "ended");
export const colors = { start: "tan", slip: "blue", riding: "teal", ended: "purple", "after a restart": "orange" };
