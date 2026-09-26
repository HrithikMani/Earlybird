#!/usr/bin/env bash
# Earlybird setup for macOS / Linux. Makes sure Node 22+ exists, then runs `npm run setup`.
set -euo pipefail
cd "$(dirname "$0")"

need_node() {
  if ! command -v node >/dev/null 2>&1; then return 0; fi
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -lt 22 ]
}

if need_node; then
  echo "Node.js 22+ is required."
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    read -r -p "Install Node 22 with Homebrew now? [Y/n] " ans
    if [ "${ans:-Y}" != "n" ] && [ "${ans:-Y}" != "N" ]; then
      brew install node@22
      brew link --overwrite --force node@22
    fi
  elif [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm install 22 && nvm use 22
  fi
  if need_node; then
    echo "Please install Node 22 LTS from https://nodejs.org (or via nvm: https://github.com/nvm-sh/nvm) and re-run ./setup.sh"
    exit 1
  fi
fi

echo "Using Node $(node -v)"
npm run setup -- "$@"
