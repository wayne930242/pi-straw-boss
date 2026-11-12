#!/bin/sh
# Writes every config of the auto-watch model and checks each with the statechart command.
# Usage: sh check.sh [name ...]   (no name: all of them). Each result goes to check/<name>/, which
# is removed first; only check/small/{chart.mmd,report.md} is kept under version control.
# STATECHART names the command (default: the user's statechart skill).
set -u
cd "$(dirname "$0")"
SC="${STATECHART:-$HOME/.agents/skills/statechart/scripts/statechart}"
ALL='"Ledger", "DropHead", "DropMark", "WaitAll", "Untold", "MorningOpen", "CrashBound", "KeyCounter", "KeyTime", "KeepCount"'
RULES_ALL="ToldOnlyWhenTaken OneWaits NoStaleNotice MorningWhole CrashBound KeysUnique NoSendOver NeverCalm"
# A lost period file starts the watch's state again: what it saw (W3) and its row of parks (W4) go with it.
RULES_BAD="ToldOnlyWhenTaken OneWaits NoStaleNotice KeysUnique NoSendOver NeverCalm"

rm -f cfg/*.cfg cfg/*/*.cfg
# cfg NAME DESIGN FIXES MUTATIONS FINDINGS PERIODS READINGS CRASH QUIT PURGE RESTART REOPEN BAD RULES
cfg() {
	mkdir -p "cfg/$(dirname "$1")"
	{
		echo "SPECIFICATION Spec"
		echo "CONSTANTS"
		echo "  Design = \"$2\""
		echo "  Fixes = {$3}"
		echo "  Mutations = {$4}"
		echo "  Findings = {$5}"
		echo "  Periods = $6"
		echo "  MaxReadings = $7"
		echo "  MaxCrashes = $8"
		echo "  MaxQuits = $9"
		echo "  MaxPurges = ${10}"
		echo "  MaxRestarts = ${11}"
		echo "  MaxReopens = ${12}"
		echo "  MaxBad = ${13}"
		echo "CHECK_DEADLOCK FALSE"
		for r in ${14}; do echo "INVARIANT $r"; done
	} >"cfg/$1.cfg"
}
without() { out="$ALL"; for f in "$@"; do out=$(echo "$out" | sed "s/\"$f\"//; s/, ,/,/g; s/^, //; s/, \$//"); done; echo "$out"; }
# The families (each checked whole): CRASH, crashes and parks over one period; RESTART, the server
# stops with a run in flight; HEAD, the head closed and opened again, a run quit, a queue purged;
# PERIODS, two periods; BADFILE, the period file broken or lost (W3 is not kept when it is lost).
CRASH='"a", "b"' ; CRASH_N="1 4 4 0 0 0 0 0"
RESTART_N="1 3 4 0 0 1 0 0"
HEAD_N="1 3 1 1 1 0 1 0"
PERIODS_N="2 3 1 0 0 0 1 0"
BADFILE_N="1 4 4 1 0 0 0 1"
# shellcheck disable=SC2086
fam() { name=$1 design=$2 fixes=$3 muts=$4 findings=$5 nums=$6 rules=$7; set -- $nums; cfg "$name" "$design" "$fixes" "$muts" "$findings" "$@" "$rules"; }

# The chart the reader confirms: one period, one finding, nothing failing, the decided design.
cfg small decided "$ALL" "" '"a"' 1 3 0 0 0 0 0 0 "$RULES_ALL"
fam crash decided "$ALL" "" "$CRASH" "$CRASH_N" "$RULES_ALL"
fam restart decided "$ALL" "" "$CRASH" "$RESTART_N" "$RULES_ALL"
fam head decided "$ALL" "" "$CRASH" "$HEAD_N" "$RULES_ALL"
fam periods decided "$ALL" "" '"a"' "$PERIODS_N" "$RULES_ALL"
fam badfile decided "$ALL" "" '"a"' "$BADFILE_N" "$RULES_BAD"
# The code at 1ffea42f in the same families.
fam today/crash today "" "" "$CRASH" "$CRASH_N" "$RULES_ALL"
fam today/restart today "" "" "$CRASH" "$RESTART_N" "$RULES_ALL"
fam today/head today "" "" "$CRASH" "$HEAD_N" "$RULES_ALL"
fam today/periods today "" "" '"a"' "$PERIODS_N" "$RULES_ALL"
fam today/badfile today "" "" '"a"' "$BADFILE_N" "$RULES_BAD"
# Each fix left out, in the family that shows it; a fix whose removal breaks nothing is left out
# together with the second guard of its rule.
fam without/Ledger decided "$(without Ledger)" "" "$CRASH" "$HEAD_N" "$RULES_ALL"
fam without/DropHead decided "$(without DropHead)" "" "$CRASH" "$HEAD_N" "$RULES_ALL"
fam without/DropMark decided "$(without DropMark)" "" "$CRASH" "$CRASH_N" "$RULES_ALL"
fam without/DropMark-restart decided "$(without DropMark)" "" "$CRASH" "$RESTART_N" "$RULES_ALL"
fam without/Untold decided "$(without Untold)" "" "$CRASH" "$HEAD_N" "$RULES_ALL"
fam without/Untold-crash decided "$(without Untold)" "" "$CRASH" "$CRASH_N" "$RULES_ALL"
fam without/MorningOpen decided "$(without MorningOpen)" "" "$CRASH" "$CRASH_N" "$RULES_ALL"
fam without/CrashBound decided "$(without CrashBound)" "" "$CRASH" "$CRASH_N" "$RULES_ALL"
fam without/KeyTime decided "$(without KeyTime)" "" '"a"' "$BADFILE_N" "$RULES_BAD"
fam without/KeyCounter decided "$(without KeyCounter)" "" "$CRASH" "$HEAD_N" "$RULES_ALL"
fam without/KeyCounter+KeyTime decided "$(without KeyCounter KeyTime)" "" "$CRASH" "$HEAD_N" "$RULES_ALL"
fam without/WaitAll decided "$(without WaitAll)" "" '"a"' "$BADFILE_N" "$RULES_BAD"
fam without/KeepCount decided "$(without KeepCount)" "" '"a"' "$BADFILE_N" "$RULES_BAD"
fam without/KeepCount+KeyCounter+KeyTime decided "$(without KeepCount KeyCounter KeyTime)" "" '"a"' "$BADFILE_N" "$RULES_BAD"
# Mutations: the way wrong code would behave, for the rules no fix holds.
cfg mutate/NoPendingCheck decided "$ALL" '"NoPendingCheck"' '"a"' 1 3 0 0 0 0 0 0 "$RULES_ALL"
cfg mutate/NoWaitGuard decided "$ALL" '"NoWaitGuard"' '"a"' 1 3 0 0 0 0 0 0 "$RULES_ALL"
cfg mutate/NoPendingCheck+NoWaitGuard decided "$ALL" '"NoPendingCheck", "NoWaitGuard"' '"a"' 1 3 0 0 0 0 0 0 "$RULES_ALL"
cfg mutate/SendCalm decided "$ALL" '"SendCalm"' '"a"' 1 3 0 0 0 0 0 0 "$RULES_ALL"

names="${*:-$(cd cfg && find . -name "*.cfg" | sed "s|^./||; s|.cfg$||" | sort)}"
for n in $names; do
	rm -f "check/$n"/*; [ -d "check/$n" ] && rmdir "check/$n"
	"$SC" AutoWatch.tla --config "cfg/$n.cfg" --view view.mjs --out "check/$n" >/dev/null 2>&1
	code=$?
	states=$(sed -n 's/.*\([0-9][0-9,]*\) distinct states.*/\1/p' "check/$n/report.md" 2>/dev/null | head -1)
	broken=$(grep -o '^## [A-Za-z]* breaks' "check/$n/report.md" 2>/dev/null | sed 's/## //; s/ breaks//' | tr '\n' ' ')
	echo "$n: exit $code; ${broken:+broken: $broken}"
done
