#!/bin/bash
# Bump version across all project files
# Usage: ./scripts/bump-version.sh <version>
# Example: ./scripts/bump-version.sh 0.2.0

set -e

VERSION="$1"
if [ -z "$VERSION" ]; then
    echo "Usage: $0 <version>"
    echo "Example: $0 0.2.0"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "Bumping version to $VERSION..."

# package.json
cd "$PROJECT_ROOT"
npm version "$VERSION" --no-git-tag-version

# tauri.conf.json
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json

# Cargo.toml
sed -i "s/^version = \".*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml

echo "Updated:"
echo "  package.json: $(grep '"version"' package.json | head -1 | tr -d ' ,')"
echo "  tauri.conf.json: $(grep '"version"' src-tauri/tauri.conf.json | head -1 | tr -d ' ,')"
echo "  Cargo.toml: $(grep '^version' src-tauri/Cargo.toml)"

git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "chore: bump version to $VERSION"
git tag "v$VERSION"

echo ""
echo "Version bumped and tagged. Run 'git push && git push --tags' to trigger release."
