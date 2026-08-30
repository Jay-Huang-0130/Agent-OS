#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

usage() {
    echo "Usage: generate-tls.sh STATE_ROOT [--force]" >&2
}

[[ $# -ge 1 && $# -le 2 ]] || {
    usage
    exit 64
}

state_root=$1
force=0
if [[ ${2:-} == --force ]]; then
    force=1
elif [[ -n ${2:-} ]]; then
    usage
    exit 64
fi

command -v openssl >/dev/null 2>&1 || {
    echo "OpenSSL is required to create the initial Agent-OS HTTPS certificate." >&2
    exit 69
}

tls_dir=$state_root/tls
key_file=$tls_dir/server.key
cert_file=$tls_dir/server.crt
install -d -m 0700 "$tls_dir"

if [[ -s "$key_file" && -s "$cert_file" && $force -eq 0 ]]; then
    chmod 0600 "$key_file"
    chmod 0644 "$cert_file"
    printf 'TLS_KEY_FILE=%s\nTLS_CERT_FILE=%s\n' "$key_file" "$cert_file"
    exit 0
fi

temporary_dir=$(mktemp -d "$tls_dir/.generate.XXXXXX")
trap 'rm -rf -- "$temporary_dir"' EXIT
openssl_config=$temporary_dir/openssl.cnf

{
    printf '%s\n' \
        '[req]' \
        'prompt = no' \
        'distinguished_name = dn' \
        'x509_extensions = extensions' \
        '[dn]' \
        'CN = agent-os.local' \
        '[extensions]' \
        'subjectAltName = @alt_names' \
        'keyUsage = critical, digitalSignature, keyEncipherment' \
        'extendedKeyUsage = serverAuth' \
        '[alt_names]' \
        'DNS.1 = agent-os.local' \
        'DNS.2 = localhost' \
        'IP.1 = 127.0.0.1'

    dns_index=3
    if hostname_value=$(hostname 2>/dev/null) && \
        [[ "$hostname_value" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
        printf 'DNS.%s = %s\n' "$dns_index" "$hostname_value"
    fi

    ip_index=2
    ip_candidates=$(hostname -I 2>/dev/null || true)
    for ip_address in $ip_candidates; do
        if [[ "$ip_address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ && \
            "$ip_address" != 127.* ]]; then
            printf 'IP.%s = %s\n' "$ip_index" "$ip_address"
            ((ip_index += 1))
        fi
    done
} >"$openssl_config"

openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 825 \
    -config "$openssl_config" \
    -keyout "$temporary_dir/server.key" \
    -out "$temporary_dir/server.crt" >/dev/null 2>&1

install -m 0600 "$temporary_dir/server.key" "$key_file"
install -m 0644 "$temporary_dir/server.crt" "$cert_file"
rm -rf -- "$temporary_dir"
trap - EXIT

printf 'TLS_KEY_FILE=%s\nTLS_CERT_FILE=%s\n' "$key_file" "$cert_file"
