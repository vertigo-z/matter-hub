#!/bin/sh
# MATTER//HUB container entrypoint.
#
# Sensible container defaults, overridable through env (HUB_HOST, HUB_PORT,
# HUB_STORAGE) or through extra arguments — later occurrences win in the
# matter.js variable service, so `podman run matter-hub --loglevel detail`
# and even `--port=9000` overrides work.
set -e

exec node hub/src/index.js \
    --host="${HUB_HOST:-0.0.0.0}" \
    --port="${HUB_PORT:-8410}" \
    --storage-path="${HUB_STORAGE:-/data}" \
    "$@"
