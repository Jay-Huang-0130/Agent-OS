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
    package.json
    package-lock.json
    config/components.env
    config/release.env
    apps/gateway/package.json
    apps/gateway/src/server.ts
    apps/web/package.json
    apps/web/src/main.tsx
    apps/web/src/App.tsx
    scripts/install-agent-web.sh
    scripts/install-node-runtime.sh
    scripts/generate-tls.sh
    scripts/agent-osctl
    systemd/agent-os.service.in
    docs/AGENT-WEB-INTEGRATION.md
)
for required_file in "${required_files[@]}"; do
    [[ -f "$required_file" ]] || {
        echo "Missing required file: $required_file" >&2
        exit 1
    }
done

for shell_file in bootstrap.sh install.sh validate.sh config/components.env config/release.env scripts/*.sh scripts/agent-osctl; do
    bash -n "$shell_file"
done

grep -q 'agent-webctl info' scripts/install-agent-web.sh
grep -q 'READY' scripts/install-agent-web.sh
grep -q -- '--non-interactive' scripts/install-agent-web.sh
grep -q -- '--password-file' scripts/install-agent-web.sh
grep -q 'AGENT_OS_AGENT_WEB_PASSWORD_FILE' docs/AGENT-WEB-INTEGRATION.md
grep -q 'AGENT_OS_NODE_VERSION:=24.20.0' config/release.env
grep -q '3515603e2487879a39bc75716f1a2affd027500c64ba50e845cf72cb33219013' scripts/install-node-runtime.sh
grep -q '855d581f8a4eb1a8117e3426de25fe02770592febcfb31369aee1ffbfee9e8ec' scripts/install-node-runtime.sh
grep -q 'source "$runtime_config"' install.sh
grep -q 'systemctl --user restart agent-os.service' install.sh
grep -q '^WorkingDirectory=@CURRENT_ROOT@$' systemd/agent-os.service.in
if grep -q '^WorkingDirectory="' systemd/agent-os.service.in; then
    echo "WorkingDirectory must not be quoted; systemd treats the quotes as part of the path." >&2
    exit 1
fi
grep -q '/api/v1/setup/complete' apps/gateway/src/app.ts
grep -q '/api/v1/events' apps/gateway/src/app.ts

if grep -R -n -E --include='*.sh' --exclude-dir=node_modules --exclude-dir=.git -- '--password[ =][^f]' .; then
    echo "A plaintext password command-line option may have been introduced." >&2
    exit 1
fi

if command -v npm >/dev/null 2>&1 && [[ -d node_modules ]]; then
    npm run typecheck
fi

echo "Agent-OS Phase 0-2 validation passed."
