#!/bin/bash
# Initial Debian 12 host preparation. Does not deploy or expose the application.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
test "$ID" = debian && test "$VERSION_ID" = 12
test "$(dpkg --print-architecture)" = amd64
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg nginx python3-venv python3-pip openssl
install -m 0755 -d /etc/apt/keyrings
curl --fail --silent --show-error https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod 644 /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<'EOF'
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: bookworm
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker nginx

node_version=$(curl --fail --silent --show-error https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(x["version"] for x in json.load(sys.stdin) if x["version"].startswith("v22.")))')
node_dir=$(mktemp -d)
cd "$node_dir"
curl --fail --silent --show-error "https://nodejs.org/dist/$node_version/node-$node_version-linux-x64.tar.xz" -O
curl --fail --silent --show-error "https://nodejs.org/dist/$node_version/SHASUMS256.txt" -O
awk -v name="node-$node_version-linux-x64.tar.xz" '$2 == name' SHASUMS256.txt | sha256sum -c -
tar -xJf "node-$node_version-linux-x64.tar.xz" -C /opt
for binary in node npm npx; do ln -sfn "/opt/node-$node_version-linux-x64/bin/$binary" "/usr/local/bin/$binary"; done
id enclave >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/enclave --shell /usr/sbin/nologin enclave
install -d -o enclave -g enclave -m 750 /opt/enclave
python3 -m venv /opt/enclave-certbot
/opt/enclave-certbot/bin/pip install --quiet 'certbot>=5.4,<6'
node --version
docker compose version
/opt/enclave-certbot/bin/certbot --version
echo 'Host preparation complete.'
