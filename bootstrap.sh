#!/usr/bin/env bash
set -Eeuo pipefail

repo_slug=${AGENT_OS_REPO_SLUG:-Jay-Huang-0130/Agent-OS}
source_ref=${AGENT_OS_REF:-main}
source_ref_type=${AGENT_OS_REF_TYPE:-}

usage() {
    cat <<'EOF'
Usage: bootstrap.sh [INSTALL_OPTIONS]

Environment:
  AGENT_OS_REF                 Git branch or tag to install (default: main)
  AGENT_OS_REF_TYPE            branch or tag; inferred when omitted
  AGENT_OS_SOURCE_URL          Override the source tarball URL
  AGENT_OS_SOURCE_SHA256       Expected source tarball SHA-256 (optional)
  AGENT_OS_SOURCE_SHA256_URL   URL containing the expected SHA-256 (optional)
  AGENT_OS_SOURCE_DIR          Install directly from a local checkout

All remaining options are passed to install.sh.
EOF
}

if [[ ${1:-} == -h || ${1:-} == --help ]]; then
    usage
    exit 0
fi

if [[ $EUID -eq 0 ]]; then
    echo "Do not run Agent-OS bootstrap as root. Use your normal login user." >&2
    exit 77
fi

[[ $(uname -s) == Linux ]] || {
    echo "Agent-OS server installation currently supports Linux only." >&2
    exit 69
}

if [[ -n ${AGENT_OS_SOURCE_DIR:-} ]]; then
    source_dir=$(cd -- "$AGENT_OS_SOURCE_DIR" && pwd)
    [[ -f "$source_dir/install.sh" ]] || {
        echo "AGENT_OS_SOURCE_DIR does not contain install.sh: $source_dir" >&2
        exit 66
    }
    exec bash "$source_dir/install.sh" "$@"
fi

for required_command in curl find install tar sha256sum; do
    command -v "$required_command" >/dev/null 2>&1 || {
        echo "Missing required bootstrap command: $required_command" >&2
        exit 69
    }
done

if [[ ! "$source_ref" =~ ^[A-Za-z0-9._/-]+$ || "$source_ref" == *..* ]]; then
    echo "Unsafe Agent-OS source ref: $source_ref" >&2
    exit 64
fi

if [[ -z "$source_ref_type" ]]; then
    if [[ "$source_ref" == v[0-9]* || "$source_ref" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
        source_ref_type=tag
    else
        source_ref_type=branch
    fi
fi
case "$source_ref_type" in
    branch)
        archive_path="refs/heads/$source_ref"
        ;;
    tag)
        archive_path="refs/tags/$source_ref"
        ;;
    *)
        echo "AGENT_OS_REF_TYPE must be branch or tag." >&2
        exit 64
        ;;
esac

source_url=${AGENT_OS_SOURCE_URL:-https://github.com/${repo_slug}/archive/${archive_path}.tar.gz}
temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT
archive_file=$temporary_dir/agent-os-source.tar.gz

echo "Downloading Agent-OS source ($source_ref_type: $source_ref)..."
curl --fail --silent --show-error --location --retry 3 "$source_url" -o "$archive_file"

expected_source_hash=${AGENT_OS_SOURCE_SHA256:-}
if [[ -z "$expected_source_hash" && -n ${AGENT_OS_SOURCE_SHA256_URL:-} ]]; then
    checksum_file=$temporary_dir/source.sha256
    curl --fail --silent --show-error --location --retry 3 \
        "$AGENT_OS_SOURCE_SHA256_URL" -o "$checksum_file"
    expected_source_hash=$(awk 'NF { print $1; exit }' "$checksum_file")
fi
if [[ -n "$expected_source_hash" ]]; then
    if [[ ! "$expected_source_hash" =~ ^[[:xdigit:]]{64}$ ]]; then
        echo "Invalid AGENT_OS_SOURCE_SHA256 value." >&2
        exit 65
    fi
    actual_source_hash=$(sha256sum "$archive_file" | awk '{ print $1 }')
    if [[ "$actual_source_hash" != "$expected_source_hash" ]]; then
        echo "Agent-OS source checksum verification failed." >&2
        exit 65
    fi
    echo "Agent-OS source checksum verified."
else
    echo "Warning: no source checksum was supplied for $source_ref_type $source_ref." >&2
    echo "Set AGENT_OS_SOURCE_SHA256 or AGENT_OS_SOURCE_SHA256_URL for a verified install." >&2
fi

extract_root=$temporary_dir/source
install -d -m 0755 "$extract_root"
unsafe_entry=$(tar -tzf "$archive_file" | awk '$0 ~ /^\// || $0 ~ /(^|\/)\.\.($|\/)/ { print; exit }')
if [[ -n "$unsafe_entry" ]]; then
    echo "The Agent-OS source archive contains an unsafe path: $unsafe_entry" >&2
    exit 65
fi
tar -xzf "$archive_file" -C "$extract_root"
install_script=$(find "$extract_root" -mindepth 2 -maxdepth 2 -type f \
    -name install.sh -print -quit)
[[ -n "$install_script" ]] || {
    echo "Downloaded Agent-OS archive does not contain install.sh." >&2
    exit 65
}

release_id=${AGENT_OS_RELEASE_ID:-$source_ref}
AGENT_OS_RELEASE_ID=$release_id bash "$install_script" "$@"
