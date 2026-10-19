#!/usr/bin/env bash
# Runs a plugin script with node: `run.sh reaper.mjs sweep`.
# Herdr starts plugin commands with the PATH of whatever started its server, and a Herdr launched from a macOS app has only
# /usr/bin:/bin:/usr/sbin:/sbin, so a plain `node` fails there. Look on PATH first, then where node usually lives.
set -euo pipefail
cd "$(dirname "$0")"

find_node() {
	local dir found
	if command -v node; then
		return
	fi
	for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/share/mise/shims" "$HOME/.asdf/shims" "$HOME/.volta/bin"; do
		if [[ -x "$dir/node" ]]; then
			echo "$dir/node"
			return
		fi
	done
	# A login shell has the PATH from the user's profile. Its last output line is the answer; a profile may print before it.
	found="$("${SHELL:-/bin/sh}" -lc 'command -v node' 2>/dev/null || true)"
	if [[ -x "${found##*$'\n'}" ]]; then
		echo "${found##*$'\n'}"
	fi
}

node_bin="$(find_node)"
if [[ -z "$node_bin" ]]; then
	echo "node not found on PATH ($PATH), in the usual install directories, or through a login shell; start Herdr from a shell whose PATH has node" >&2
	exit 127
fi
exec "$node_bin" "$@"
