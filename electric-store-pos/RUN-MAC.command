#!/bin/zsh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null; then echo 'Install Node.js 22 LTS first'; exit 1; fi
if [ ! -d node_modules ]; then npm install || exit 1; fi
npm run dev
