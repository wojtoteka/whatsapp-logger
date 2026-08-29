#!/usr/bin/env bash

# Przygotowanie WhatsApp Loggera na Debianie:
# - sprawdza Node.js,
# - instaluje Chromium, jeśli go brakuje,
# - instaluje zależności loggera i panelu,
# - tworzy wyłącznie brakujące pliki .env,
# - buduje obie aplikacje.
#
# Nie zmienia istniejących .env, logs, sesji WhatsAppa ani bazy danych.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PANEL_DIR="$ROOT_DIR/panel"
INSTALL_CHROMIUM=true

for arg in "$@"; do
    case "$arg" in
        --bez-chromium)
            INSTALL_CHROMIUM=false
            ;;
        -h|--help)
            echo "Użycie: bash scripts/instaluj-debian.sh [--bez-chromium]"
            exit 0
            ;;
        *)
            echo "Nieznany argument: $arg" >&2
            echo "Użycie: bash scripts/instaluj-debian.sh [--bez-chromium]" >&2
            exit 2
            ;;
    esac
done

step() {
    printf '\n==> %s\n' "$1"
}

fail() {
    echo "BŁĄD: $1" >&2
    exit 1
}

as_root() {
    if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@"
    else
        return 1
    fi
}

check_debian() {
    [[ -r /etc/os-release ]] || fail "nie znaleziono /etc/os-release"
    # shellcheck disable=SC1091
    source /etc/os-release
    if [[ "${ID:-}" != "debian" && "${ID_LIKE:-}" != *debian* ]]; then
        echo "UWAGA: wykryto ${PRETTY_NAME:-nieznany system}; skrypt jest przygotowany dla Debiana."
    else
        echo "System: ${PRETTY_NAME:-Debian}"
    fi
}

check_node() {
    command -v node >/dev/null 2>&1 || fail "brak Node.js; wymagany jest Node.js 20.6 lub nowszy"
    command -v npm >/dev/null 2>&1 || fail "brak npm"

    if ! node -e '
        const [major, minor] = process.versions.node.split(".").map(Number);
        process.exit(major > 20 || (major === 20 && minor >= 6) ? 0 : 1);
    '; then
        fail "Node.js $(node --version) jest za stary; wymagany jest co najmniej 20.6"
    fi

    echo "Node.js: $(node --version)"
    echo "npm: $(npm --version)"
}

install_chromium() {
    if command -v chromium >/dev/null 2>&1 ||
        command -v chromium-browser >/dev/null 2>&1 ||
        command -v google-chrome >/dev/null 2>&1; then
        echo "Chromium/Chrome: już zainstalowany"
        return
    fi

    if [[ "$INSTALL_CHROMIUM" != true ]]; then
        echo "UWAGA: pominięto Chromium (--bez-chromium). Puppeteer musi mieć własną przeglądarkę."
        return
    fi

    command -v apt-get >/dev/null 2>&1 || {
        echo "UWAGA: brak apt-get; zainstaluj Chromium ręcznie."
        return
    }

    step "Instaluję Chromium z repozytorium Debiana"
    if ! as_root apt-get update; then
        echo "UWAGA: nie udało się wykonać apt-get update; zainstaluj Chromium ręcznie."
        return
    fi
    if ! as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y chromium; then
        echo "UWAGA: nie udało się zainstalować Chromium; Puppeteer spróbuje własnej kopii."
    fi
}

install_npm_project() {
    local directory="$1"
    local label="$2"

    step "Instaluję zależności: $label"
    cd -- "$directory"
    if [[ -f package-lock.json ]]; then
        npm ci --include=dev
    else
        echo "UWAGA: brak package-lock.json; używam npm install."
        npm install --include=dev
    fi
}

create_env_if_missing() {
    local example="$1"
    local target="$2"

    if [[ -f "$target" ]]; then
        echo "Zostawiam istniejący: $target"
    elif [[ -f "$example" ]]; then
        cp -- "$example" "$target"
        echo "Utworzono z przykładu: $target"
    else
        fail "brak pliku wzorcowego $example"
    fi
}

step "Sprawdzam środowisko"
check_debian
check_node
[[ -f "$ROOT_DIR/package.json" ]] || fail "brak $ROOT_DIR/package.json"
[[ -f "$PANEL_DIR/package.json" ]] || fail "brak $PANEL_DIR/package.json"

install_chromium
install_npm_project "$ROOT_DIR" "logger"
install_npm_project "$PANEL_DIR" "panel"

step "Sprawdzam konfigurację lokalną"
create_env_if_missing "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
create_env_if_missing "$PANEL_DIR/.env.example" "$PANEL_DIR/.env"

step "Buduję logger"
cd -- "$ROOT_DIR"
npm run build

step "Buduję panel"
cd -- "$PANEL_DIR"
npm run build

step "Gotowe"
echo "Katalog aplikacji: $ROOT_DIR"
if ! command -v mariadb >/dev/null 2>&1; then
    echo "UWAGA: nie znaleziono klienta MariaDB. Panel wymaga skonfigurowanej bazy do logowania."
fi
echo "Sprawdź .env oraz panel/.env, a następnie uruchom:"
echo "  cd '$ROOT_DIR'"
echo "  npm start"
