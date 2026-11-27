#!/bin/bash
# Spike 0a, step 1 inside the target environment: install pi-straw-boss the way a user does and
# record how npm resolved it. Run with HOME (and PI_CODING_AGENT_DIR) pointing at an empty scratch
# home, an empty npm cache, and no git or ssh credentials.
# usage: install.sh <registry url> <version> <evidence dir>
set -euo pipefail
REG=$1 VER=$2 OUT=$3
AGENT=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}
mkdir -p "$OUT"
CACHE=$(npm config get cache)
CACHE_BEFORE=$(ls -A "$CACHE" 2>/dev/null | grep -vx _logs | wc -l | tr -d ' ')
{
  echo "node $(node -v)  npm $(npm -v)  pi $(pi --version)  herdr $(herdr --version 2>/dev/null || echo none)  $(uname -sm)"
  echo "agent dir: $AGENT (entries before install: $(ls -A "$AGENT" 2>/dev/null | wc -l | tr -d ' '))"
  echo "npm cache: $CACHE (entries besides npm's _logs before install: $CACHE_BEFORE)"
  echo "~/.ssh: $(ls -A "$HOME/.ssh" 2>/dev/null | wc -l | tr -d ' ') entries; SSH_AUTH_SOCK=${SSH_AUTH_SOCK:+set}; GIT_TERMINAL_PROMPT=${GIT_TERMINAL_PROMPT:-unset}"
  echo "git credential.helper: '$(git config --get-all credential.helper 2>/dev/null || true)'"
} > "$OUT/env.txt"
cat "$OUT/env.txt"
start=$(date +%s)
npm_config_registry=$REG pi install "npm:pi-straw-boss@$VER" > "$OUT/install.log" 2>&1
echo "install: $(( $(date +%s) - start ))s" | tee -a "$OUT/env.txt"
python3 - "$AGENT" "$OUT" <<'EOF'
import hashlib, json, os, sys
agent, out = sys.argv[1:]
nm = os.path.join(agent, "npm", "node_modules")
lock = json.load(open(os.path.join(nm, ".package-lock.json")))["packages"]
root = os.path.join(nm, "@nubl", "maestro")
dist = os.path.join(root, "dist")
files = sorted(os.path.join(d, f) for d, _, fs in os.walk(dist) for f in fs)
h = hashlib.sha256()
for f in files:
    h.update(hashlib.sha256(open(f, "rb").read()).hexdigest().encode() + b"  " + os.path.relpath(f, root).encode() + b"\n")
peers = {p: os.path.exists(os.path.join(nm, *p.split("/"))) for p in ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "@sinclair/typebox", "typebox"]}
res = {
    "settings": json.load(open(os.path.join(agent, "settings.json"))),
    "pi-straw-boss": lock.get("node_modules/pi-straw-boss"),
    "@nubl/maestro": lock.get("node_modules/@nubl/maestro"),
    "nested maestro copies": [k for k in lock if k.endswith("node_modules/@nubl/maestro") and k != "node_modules/@nubl/maestro"],
    "maestro realpath": os.path.realpath(root),
    "maestro dist files": len(files),
    "maestro dist digest": h.hexdigest(),
    "peers present under npm/node_modules": peers,
}
json.dump(res, open(os.path.join(out, "resolution.json"), "w"), indent=2)
print(json.dumps(res, indent=2))
EOF
