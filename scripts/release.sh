#!/usr/bin/env bash
# release.sh — bump version, build, sign, notarize, and publish to GitHub Releases
#
# Usage:
#   ./scripts/release.sh          # patch bump (1.0.0 → 1.0.1)
#   ./scripts/release.sh minor    # minor bump (1.0.0 → 1.1.0)
#   ./scripts/release.sh major    # major bump (1.0.0 → 2.0.0)

set -e

BUMP=${1:-patch}

# Load local release credentials when present. Values still need to be shell-safe:
# KEY=value, with quotes around values that contain spaces.
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

# ── Preflight checks ──────────────────────────────────────────────────────────

missing=()
[[ -z "$GH_TOKEN" ]] && missing+=("GH_TOKEN")
[[ -z "$APPLE_ID" ]] && missing+=("APPLE_ID")
[[ -z "$APPLE_APP_SPECIFIC_PASSWORD" ]] && missing+=("APPLE_APP_SPECIFIC_PASSWORD")
[[ -z "$APPLE_TEAM_ID" ]] && missing+=("APPLE_TEAM_ID")

if (( ${#missing[@]} > 0 )); then
  echo "❌  Missing required release environment variable(s): ${missing[*]}"
  echo "    Add them to .env or export them from your shell before running this script."
  exit 1
fi

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "❌  Invalid bump type: '$BUMP'. Use patch, minor, or major."
  exit 1
fi

if ! command -v wine &>/dev/null; then
  echo "🍷  Wine not found — installing (needed for Windows builds on macOS)..."
  brew install --cask --quiet wine-stable
fi

# ── Bump version ──────────────────────────────────────────────────────────────

echo "🔢  Bumping $BUMP version..."
npm version $BUMP --no-git-tag-version

VERSION=$(node -p "require('./package.json').version")
echo "📦  Building Lobi v$VERSION for macOS + Windows"

# ── Build & publish ───────────────────────────────────────────────────────────

echo ""
echo "🍎  Building macOS (sign + notarize + publish)..."
npm run publish:mac

echo ""
echo "🪟  Building Windows (publish)..."
npm run publish:win

echo ""
echo "✅  Lobi v$VERSION published to GitHub Releases."
echo "    Users will get the update automatically on next launch."
echo ""

# ── Commit the version bump ───────────────────────────────────────────────────

git add package.json package-lock.json
git commit -m "chore: release v$VERSION"
git push
