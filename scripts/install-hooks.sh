#!/bin/bash
# Install git hooks for the haruspex project.
# Run once after cloning or on a new machine.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

# Pre-commit: block commits with Prettier formatting issues
cat > "$HOOKS_DIR/pre-commit" << 'HOOK'
#!/bin/bash
npm run format:check 2>&1
if [ $? -ne 0 ]; then
    echo ""
    echo "Commit blocked: Prettier formatting issues found."
    echo "Run 'npm run format' to fix, then re-commit."
    exit 1
fi
HOOK
chmod +x "$HOOKS_DIR/pre-commit"

echo "Git hooks installed."
