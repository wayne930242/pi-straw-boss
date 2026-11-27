#!/bin/bash
# Spike 0a, step 2 inside the target environment: open a workspace in the given (isolated) Herdr
# session, run a real parent pi there on the scripted model, wait until the parent's session holds
# the delivered child result, record the evidence, and close the workspace.
# Needs scripted-model.mjs on 127.0.0.1:4874 and the probe next to this script.
# usage: drive.sh <herdr session> <evidence dir> <work dir>
set -euo pipefail
SESSION=$1 OUT=$2 WORK=$3
HERE=$(cd "$(dirname "$0")" && pwd)
AGENT=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}
mkdir -p "$OUT" "$WORK"
H() { herdr --session "$SESSION" "$@"; }
cat > "$AGENT/models.json" <<'EOF'
{"providers":{"spike":{"baseUrl":"http://127.0.0.1:4874/v1","api":"openai-completions","apiKey":"spike","models":[{"id":"scripted"}]}}}
EOF
: > "$OUT/probe.jsonl"
created=$(H workspace create --cwd "$WORK" --label spike-0a --no-focus --env "SPIKE_PROBE_FILE=$OUT/probe.jsonl")
ws=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["result"]["workspace"]["workspace_id"])' "$created")
pane=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["result"]["root_pane"]["pane_id"])' "$created")
echo "workspace $ws pane $pane" | tee "$OUT/drive.txt"
# The pane's login shell may reorder PATH (macOS path_helper); give it this script's PATH.
H pane run "$pane" "export PATH='$PATH'; pi -e '$HERE/probe.ts' --model spike/scripted 'SPIKE-PARENT-GO: launch one child.'" > /dev/null
# Wait on the parent's session file (no CLI polling): done when it holds the parent's answer.
sessions="$AGENT/sessions"
deadline=$(( $(date +%s) + 180 ))
found=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  found=$(grep -l "SPIKE-PARENT-RECEIVED" "$sessions"/*/*.jsonl 2>/dev/null | head -1 || true)
  [ -n "$found" ] && break
  sleep 2
done
H pane read "$pane" --source recent --lines 60 > "$OUT/parent-pane.txt" || true
H pane list > "$OUT/panes-after.json" || true
if [ -z "$found" ]; then echo "FAIL: no SPIKE-PARENT-RECEIVED within 180s" | tee -a "$OUT/drive.txt"; else echo "parent session: $found" | tee -a "$OUT/drive.txt"; fi
python3 - "$AGENT" "$OUT" "${found:-}" <<'EOF'
import glob, json, os, re, sys
agent, out, parent = sys.argv[1:]
lines = []
if parent:
    for raw in open(parent):
        d = json.loads(raw)
        if d.get("type") == "custom_message" and d.get("customType") == "subagent_result":
            lines.append({"subagent_result": d.get("content")})
        elif d.get("type") == "message":
            m = d["message"]
            if m.get("role") == "toolResult" and m.get("toolName") == "subagent":
                lines.append({"subagent tool result": m.get("details")})
            elif m.get("role") in ("user", "assistant"):
                lines.append({m["role"]: m.get("content")})
json.dump(lines, open(os.path.join(out, "parent-session.json"), "w"), indent=2)
scripts = glob.glob(os.path.join(agent, "sessions", "*", "artifacts", "*", "subagent-scripts", "*.sh"))
with open(os.path.join(out, "launch-script.txt"), "w") as f:
    for s in scripts:
        f.write(f"# {s}\n" + re.sub(r"\b([A-Z0-9_]*(KEY|TOKEN|SECRET)[A-Z0-9_]*)=\S+", r"\1=<redacted>", open(s).read()) + "\n")
outcomes = os.path.join(agent, "herdr-agents", "outcomes.jsonl")
if os.path.exists(outcomes):
    open(os.path.join(out, "outcomes.jsonl"), "w").write(open(outcomes).read())
EOF
H workspace close "$ws" > /dev/null || true
echo "closed workspace $ws" | tee -a "$OUT/drive.txt"
[ -n "$found" ]
