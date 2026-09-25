#!/usr/bin/env bash
set -euo pipefail
# Run after each successful frontend build and before switching the web release.
# This directory contains only public hashed assets, never application configuration.
source_dir=${1:-/opt/enclave/frontend/.output/public/assets}
test -d "$source_dir"
test ! -L /var/www/enclave-public
test ! -L /var/www/enclave-public/assets
install -d -m 755 /var/www/enclave-public /var/www/enclave-public/assets
cp -a "$source_dir"/. /var/www/enclave-public/assets/
find /var/www/enclave-public/assets -type d -exec chmod 755 {} +
find /var/www/enclave-public/assets -type f -exec chmod 644 {} +
# Retain old content-addressed files for already-open tabs and rollback.
