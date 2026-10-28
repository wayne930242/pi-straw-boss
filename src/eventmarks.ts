/** The two lines the sb server writes at the head of a tower run's event (runmode.ts `eventText`); the GUI reads them back (gui/towerturns.ts), so both share these. */
export const BOSS_MARK = "[the boss writes to you from the GUI or /boss tower; this is an instruction]";
export const CRASH_FLAG = "[possibly handled by a run that crashed: check before acting]";
