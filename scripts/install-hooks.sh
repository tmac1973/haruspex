#!/bin/bash
# Install git hooks for the haruspex project.
# Run once after cloning or on a new machine.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

# Pre-commit: block commits with Prettier formatting issues
cat > "$HOOKS_DIR/pre-commit" << 'HOOK'
#!/bin/bash
# Ensure npm is reachable when invoked from GUI git clients (VS Code,
# GitHub Desktop, etc.) whose PATH may not include /usr/bin or a node
# version manager's shims.
export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$PATH"
if ! command -v npm >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
    . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi
if ! command -v npm >/dev/null 2>&1 && [ -d "$HOME/.fnm" ]; then
    export PATH="$HOME/.fnm:$PATH"
    command -v fnm >/dev/null 2>&1 && eval "$(fnm env)" >/dev/null 2>&1
fi
if ! command -v npm >/dev/null 2>&1; then
    echo "pre-commit: npm not found in PATH ($PATH)"
    echo "If using nvm/fnm/asdf, ensure your shell init exports the node bin path,"
    echo "or commit from a terminal where 'npm' resolves."
    exit 1
fi

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
