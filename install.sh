#!/usr/bin/env bash
set -Eeuo pipefail

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
force_agent_web_update=0
skip_agent_web=0

usage() {
    cat <<'EOF'
Usage: ./install.sh [--force-agent-web-update] [--skip-agent-web]

Installs the current Agent-OS foundation and its browser subsystem.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force-agent-web-update)
            force_agent_web_update=1
            ;;
        --skip-agent-web)
            skip_agent_web=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 64
            ;;
    esac
    shift
done

if [[ $EUID -eq 0 ]]; then
    echo "Run the Agent-OS installer as your normal login user, not root." >&2
    exit 77
fi

if [[ ! -r /etc/os-release ]]; then
    echo "Agent-OS requires a Linux system with /etc/os-release." >&2
    exit 69
fi

sudo -v
missing_packages=()
for package_name in ca-certificates curl git openssl; do
    if ! dpkg-query -W -f='${Status}' "$package_name" 2>/dev/null |
        grep -q '^install ok installed$'; then
        missing_packages+=("$package_name")
    fi
done
if ((${#missing_packages[@]} > 0)); then
    sudo apt-get update
    sudo apt-get install -y "${missing_packages[@]}"
fi

install -d -m 0755 "$HOME/.local/bin" "$HOME/.local/state/agent-os/components"
install -m 0755 "$project_root/scripts/agent-osctl" "$HOME/.local/bin/agent-osctl"

if [[ $skip_agent_web -eq 0 ]]; then
    component_args=()
    [[ $force_agent_web_update -eq 0 ]] || component_args+=(--force-update)
    "$project_root/scripts/install-agent-web.sh" "${component_args[@]}"
else
    echo "Skipping Agent Web by explicit request."
fi

echo
echo "Agent-OS foundation installed successfully."
echo "Run: agent-osctl doctor"
echo "Vision: $project_root/VISION.md"

