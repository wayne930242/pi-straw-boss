interface TraceEvent {
  name: string;
  ph?: string;
  dur?: number;
  args?: { data?: { frame?: string; frames?: { frame: string; isOutermostMainFrame: boolean; processId: number; url: string }[] } };
}
interface Costs { paintMs: number; documentPrePaintMs: number }
export function headCosts(events: TraceEvent[], window: TraceEvent[], pid: number): Costs & { documentPrePaint: number };
export function headGate(standard: { paint: number }, raven: Costs & { paint: number }, original: Costs): {
  paintLimit: number; workLimitMs: number; workMs: number; originalWorkMs: number; pass: boolean;
};
