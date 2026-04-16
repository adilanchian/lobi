#!/usr/bin/env bash
# release.sh — bump version, build, sign, notarize, and publish to GitHub Releases
#
# Usage:
#   ./scripts/release.sh          # patch bump (1.0.0 → 1.0.1)
#   ./scripts/release.sh minor    # minor bump (1.0.0 → 1.1.0)
#   ./scripts/release.sh major    # major bump (1.0.0 → 2.0.0)

set -e

BUMP=${1:-patch}

# ── Preflight checks ──────────────────────────────────────────────────────────

if [[ -z "$GH_TOKEN" ]]; then
  echo "❌  GH_TOKEN is not set. Add it to your ~/.zshrc and run: source ~/.zshrc"
  exit 1
fi

if [[ -z "$APPLE_ID" || -z "$APPLE_APP_SPECIFIC_PASSWORD" ]]; then
  echo "❌  APPLE_ID or APPLE_APP_SPECIFIC_PASSWORD is not set. Add them to your ~/.zshrc"
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
