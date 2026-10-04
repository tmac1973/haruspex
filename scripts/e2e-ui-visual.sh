#!/usr/bin/env bash
# Run the @visual UI specs inside the pinned Playwright image, where their
# baselines were made: fonts and rendering differ between machines, so a
# screenshot compared anywhere else fails for reasons that are not the app's.
#
#   scripts/e2e-ui-visual.sh                       compare
#   scripts/e2e-ui-visual.sh --update-snapshots    remake the baselines
#
# Needs podman or docker. Keep IMAGE in step with @playwright/test in
# package.json and with the e2e-ui job in .github/workflows/ci.yml.
set -euo pipefail
IMAGE=mcr.microsoft.com/playwright:v1.63.0-noble
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
run=$(command -v podman || command -v docker) || {
    echo "needs podman or docker" >&2
    exit 1
}
extra=()
[[ $run == *podman ]] && extra+=(--userns=keep-id)
exec "$run" run --rm --network host "${extra[@]}" \
    -v "$root:/work:Z" -w /work -e E2E_VISUAL=1 -e HOME=/tmp \
    "$IMAGE" npx playwright test --grep @visual "$@"
