#!/usr/bin/env sh

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
    printf '\nQuickSearch needs Node.js to run the server-side proxy.\n'
    printf 'Install the Node.js LTS version, then run this file again.\n\n'
    printf 'You can still open quicksearch.html directly, but proxy mode will be limited.\n\n'
    exit 1
fi

node --max-old-space-size=128 launcher.js "$@"
