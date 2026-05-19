#!/usr/bin/env bash

set -euo pipefail

SKIP_TESTS=false
ARGS=()

for arg in "$@"; do
  case "$arg" in
    --skip-tests)
      SKIP_TESTS=true
      ;;
    *)
      ARGS+=("$arg")
      ;;
  esac
done

if [[ "$SKIP_TESTS" == "true" ]]; then
  echo "Skipping tests because --skip-tests was provided."
else
  echo "Running tests before electron-builder..."
  npm test
fi

npx electron-builder "${ARGS[@]}"
