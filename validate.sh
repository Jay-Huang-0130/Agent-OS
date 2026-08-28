#!/usr/bin/env bash
set -Eeuo pipefail

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$project_root"

required_files=(
    .gitattributes
    .gitignore
    README.md
    VISION.md
    bootstrap.sh
    install.sh
    validate.sh
    config/components.env
    scripts/install-agent-web.sh
    scripts/agent-osctl
    docs/AGENT-WEB-INTEGRATION.md
)
for required_file in "${required_files[@]}"; do
    [[ -f "$required_file" ]] || {
        echo "Missing required file: $required_file" >&2
        exit 1
    }
done

for shell_file in bootstrap.sh install.sh validate.sh config/components.env scripts/*.sh scripts/agent-osctl; do
    bash -n "$shell_file"
done

grep -q 'agent-webctl info' scripts/install-agent-web.sh
grep -q 'READY' scripts/install-agent-web.sh
grep -q -- '--non-interactive' scripts/install-agent-web.sh
grep -q -- '--password-file' scripts/install-agent-web.sh
grep -q 'AGENT_OS_AGENT_WEB_PASSWORD_FILE' docs/AGENT-WEB-INTEGRATION.md

if grep -R -n -E --include='*.sh' -- '--password[ =][^f]' .; then
    echo "A plaintext password command-line option may have been introduced." >&2
    exit 1
fi

echo "Agent-OS foundation validation passed."
