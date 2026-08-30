#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
    cat <<'EOF'
Usage: install-node-runtime.sh RUNTIME_ROOT NODE_VERSION [DIST_URL]

Downloads a pinned official Node.js Linux binary into an Agent-OS-owned
directory, verifies its embedded release checksum, and prints the runtime path.
EOF
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
    usage >&2
    exit 64
fi

runtime_root=$1
node_version=${2#v}
dist_url=${3:-https://nodejs.org/download/release}

[[ $(uname -s) == Linux ]] || {
    echo "The managed Node.js runtime currently supports Linux only." >&2
    exit 69
}

case "$(uname -m)" in
    x86_64|amd64)
        node_arch=x64
        expected_hash=855d581f8a4eb1a8117e3426de25fe02770592febcfb31369aee1ffbfee9e8ec
        ;;
    aarch64|arm64)
        node_arch=arm64
        expected_hash=3515603e2487879a39bc75716f1a2affd027500c64ba50e845cf72cb33219013
        ;;
    armv7l|armv7*)
        echo "32-bit ARM is not supported by the production runtime." >&2
        echo "Install 64-bit Raspberry Pi OS, then run the installer again." >&2
        exit 69
        ;;
    *)
        echo "Unsupported CPU architecture for managed Node.js: $(uname -m)" >&2
        echo "Supported architectures: x86_64 and aarch64/arm64." >&2
        exit 69
        ;;
esac

if [[ "$node_version" != 24.20.0 ]]; then
    echo "No trusted runtime checksum is bundled for Node.js v${node_version}." >&2
    echo "This Agent-OS release requires Node.js v24.20.0." >&2
    exit 65
fi

long_bits=$(getconf LONG_BIT 2>/dev/null || true)
[[ "$long_bits" == 64 ]] || {
    echo "Agent-OS requires a 64-bit Linux userspace." >&2
    exit 69
}

glibc_description=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
if [[ ! "$glibc_description" =~ ^glibc[[:space:]]+([0-9]+)\.([0-9]+) ]]; then
    echo "Agent-OS requires a glibc-based Linux distribution (glibc 2.28 or newer)." >&2
    echo "Alpine/musl is not supported in Phase 0-2." >&2
    exit 69
fi
glibc_major=${BASH_REMATCH[1]}
glibc_minor=${BASH_REMATCH[2]}
if (( glibc_major < 2 || (glibc_major == 2 && glibc_minor < 28) )); then
    echo "glibc 2.28 or newer is required; found ${glibc_major}.${glibc_minor}." >&2
    exit 69
fi

for required_command in curl tar sha256sum; do
    command -v "$required_command" >/dev/null 2>&1 || {
        echo "Missing required command: $required_command" >&2
        exit 69
    }
done

archive_name="node-v${node_version}-linux-${node_arch}.tar.gz"
release_url="${dist_url%/}/v${node_version}"
runtime_dir="$runtime_root/v${node_version}-linux-${node_arch}"
node_binary="$runtime_dir/bin/node"

if [[ -x "$node_binary" ]]; then
    installed_version=$($node_binary --version 2>/dev/null || true)
    if [[ "$installed_version" == "v${node_version}" ]]; then
        install -d -m 0755 "$runtime_root"
        ln -sfn "$runtime_dir" "$runtime_root/current"
        printf '%s\n' "$runtime_dir"
        exit 0
    fi
    echo "Existing managed Node.js runtime is invalid: $runtime_dir" >&2
    exit 70
fi

install -d -m 0755 "$runtime_root"
temporary_dir=$(mktemp -d "$runtime_root/.node-${node_version}-${node_arch}.XXXXXX")
staging_dir=$(mktemp -d "$runtime_root/.node-runtime-${node_version}-${node_arch}.XXXXXX")
cleanup() {
    rm -rf -- "$temporary_dir" "$staging_dir"
}
trap cleanup EXIT

echo "Downloading Node.js v${node_version} for linux-${node_arch}..." >&2
curl --fail --silent --show-error --location --retry 3 \
    "$release_url/$archive_name" -o "$temporary_dir/$archive_name"
actual_hash=$(sha256sum "$temporary_dir/$archive_name" | awk '{ print $1 }')
if [[ "$actual_hash" != "$expected_hash" ]]; then
    echo "Node.js archive checksum verification failed." >&2
    echo "Expected: $expected_hash" >&2
    echo "Actual:   $actual_hash" >&2
    exit 65
fi

unexpected_entry=$(tar -tzf "$temporary_dir/$archive_name" | \
    awk -v root="node-v${node_version}-linux-${node_arch}/" \
    'index($0, root) != 1 || $0 ~ /(^|\/)\.\.($|\/)/ { print; exit }')
if [[ -n "$unexpected_entry" ]]; then
    echo "The Node.js archive contains an unexpected path: $unexpected_entry" >&2
    exit 65
fi

tar -xzf "$temporary_dir/$archive_name" --strip-components=1 -C "$staging_dir"
if [[ ! -x "$staging_dir/bin/node" ]]; then
    echo "The verified Node.js archive did not contain bin/node." >&2
    exit 65
fi

extracted_version=$($staging_dir/bin/node --version 2>/dev/null || true)
if [[ "$extracted_version" != "v${node_version}" ]]; then
    echo "The downloaded Node.js binary cannot run on this Linux system." >&2
    echo "Expected v${node_version}, received: ${extracted_version:-no output}" >&2
    exit 70
fi

mv -- "$staging_dir" "$runtime_dir"
ln -sfn "$runtime_dir" "$runtime_root/current"
rm -rf -- "$temporary_dir"
trap - EXIT
printf '%s\n' "$runtime_dir"
