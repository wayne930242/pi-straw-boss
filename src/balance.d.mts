export interface Rect { x: number; y: number; width: number; height: number }
export interface Split { id: string; direction: "right" | "down"; ratio: number; rect: Rect }
export interface Pane { pane_id: string; rect: Rect }
export interface Layout { panes: Pane[]; splits: Split[]; zoomed?: boolean }
export interface Resize { pane: string; direction: "left" | "right" | "up" | "down"; amount: number }
export type Run = (args: string[]) => Promise<string>;

export function planBalance(layout: Layout): Resize[];
export const herdr: Run;
export function balanceTab(paneId: string, options?: { run?: Run; lockRoot?: string }): Promise<void>;
export function balanceAfterClose(paneId: string, tabId: string | undefined, options?: { run?: Run; lockRoot?: string; pollMs?: number; waitMs?: number }): Promise<void>;
