#!/usr/bin/env bash
set -Eeuo pipefail

mkdir -p \
    "${HOME}/pi-telegram-bot" \
    "${HOME}/.local/share/pi-telegram-bot/sessions" \
    "${HOME}/.pi/agent" \
    "${HOME}/code" \
    "${HOME}/.ssh"

if [[ ! -f "${HOME}/pi-telegram-bot/config.yaml" && -f /opt/pi-telegram-bot/config.example.yaml ]]; then
    cp /opt/pi-telegram-bot/config.example.yaml "${HOME}/pi-telegram-bot/config.yaml"
fi

exec "$@"
