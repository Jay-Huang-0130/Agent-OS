#!/usr/bin/env bash
set -Eeuo pipefail

repo_url=${AGENT_OS_REPO_URL:-https://github.com/Jay-Huang-0130/Agent-OS.git}
install_root=${AGENT_OS_INSTALL_ROOT:-$HOME/.local/share/agent-os}
source_dir=$install_root/source

if [[ $EUID -eq 0 ]]; then
    echo "Do not run Agent-OS bootstrap as root. Use your normal login user." >&2
    exit 77
fi

if ! command -v git >/dev/null 2>&1; then
    echo "Installing Git..."
    sudo apt-get update
    sudo apt-get install -y git ca-certificates
fi

mkdir -p "$install_root"
if [[ -d "$source_dir/.git" ]]; then
    git -C "$source_dir" remote set-url origin "$repo_url"
    git -C "$source_dir" fetch origin main
    git -C "$source_dir" checkout main
    git -C "$source_dir" merge --ff-only origin/main
elif [[ -e "$source_dir" ]]; then
    echo "Agent-OS source path exists but is not a Git repository: $source_dir" >&2
    exit 73
else
    git clone --depth 1 --branch main "$repo_url" "$source_dir"
fi

exec "$source_dir/install.sh" "$@"

