#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck disable=SC1091
source "$project_root/config/components.env"

if [[ -r /etc/agent-os/components.env ]]; then
    # shellcheck disable=SC1091
    source /etc/agent-os/components.env
fi

force_update=0
case "${1:-}" in
    "")
        ;;
    --force-update)
        force_update=1
        ;;
    *)
        echo "Usage: $0 [--force-update]" >&2
        exit 64
        ;;
esac

if [[ "${AGENT_OS_AGENT_WEB_ENABLED:-1}" != 1 ]]; then
    echo "Agent Web component is disabled by configuration."
    exit 0
fi

info_value() {
    local key=$1
    awk -F= -v wanted="$key" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }'
}

read_agent_web_info() {
    command -v agent-webctl >/dev/null 2>&1 || return 1
    agent-webctl info 2>/dev/null || return 1
}

agent_web_info=$(read_agent_web_info || true)
ready=$(printf '%s\n' "$agent_web_info" | info_value READY)
if [[ "$ready" == true && $force_update -eq 0 ]]; then
    echo "Agent Web is already installed and ready."
else
    already_installed=0
    command -v agent-webctl >/dev/null 2>&1 && already_installed=1

    temporary_dir=$(mktemp -d)
    trap 'rm -rf -- "$temporary_dir"' EXIT
    bootstrap_file=$temporary_dir/agent-web-bootstrap.sh
    curl -fsSL "$AGENT_OS_AGENT_WEB_BOOTSTRAP_URL" -o "$bootstrap_file"
    chmod 0700 "$bootstrap_file"

    install_args=(--non-interactive)
    generated_password=
    if [[ $already_installed -eq 0 ]]; then
        password_file=${AGENT_OS_AGENT_WEB_PASSWORD_FILE:-}
        if [[ -z "$password_file" ]]; then
            generated_password=$(openssl rand -hex 8)
            password_file=$temporary_dir/agent-web-password
            printf '%s\n' "$generated_password" >"$password_file"
            chmod 0600 "$password_file"
        elif [[ ! -r "$password_file" ]]; then
            echo "Agent Web password file is not readable: $password_file" >&2
            exit 66
        fi
        install_args+=(
            --username "$AGENT_OS_AGENT_WEB_USERNAME"
            --password-file "$password_file"
        )
    fi

    echo "Installing or repairing the Agent Web browser subsystem..."
    AGENT_WEB_REPO_URL="$AGENT_OS_AGENT_WEB_REPO_URL" \
        bash "$bootstrap_file" "${install_args[@]}"

    agent_web_info=$(read_agent_web_info || true)
    ready=$(printf '%s\n' "$agent_web_info" | info_value READY)
    if [[ "$ready" != true ]]; then
        echo "Agent Web installation finished but readiness verification failed." >&2
        printf '%s\n' "$agent_web_info" >&2
        exit 70
    fi

    if [[ -n "$generated_password" ]]; then
        human_url=$(printf '%s\n' "$agent_web_info" | info_value HUMAN_URL)
        echo
        echo "Agent Web generated credentials (shown once):"
        echo "  URL: $human_url"
        echo "  Username: $AGENT_OS_AGENT_WEB_USERNAME"
        echo "  Password: $generated_password"
        echo "Change it later with: agent-webctl set-password"
    fi
    rm -rf -- "$temporary_dir"
    trap - EXIT
fi

state_root=$HOME/.local/state/agent-os/components
install -d -m 0755 "$state_root"
source_commit=unknown
agent_web_source=$HOME/.local/share/agent-web/source
if [[ -d "$agent_web_source/.git" ]]; then
    source_commit=$(git -C "$agent_web_source" rev-parse HEAD 2>/dev/null || true)
    source_commit=${source_commit:-unknown}
fi
cat >"$state_root/agent-web.env" <<EOF
COMPONENT=agent-web
READY=true
INFO_VERSION=$(printf '%s\n' "$agent_web_info" | info_value AGENT_WEB_INFO_VERSION)
SOURCE_COMMIT=$source_commit
VERIFIED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
chmod 0644 "$state_root/agent-web.env"

echo "Agent Web component verification passed."
