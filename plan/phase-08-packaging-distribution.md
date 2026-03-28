# Phase 8: Packaging, CI/CD & Distribution

## Goal

Set up the full build pipeline: cross-platform llama-server compilation, Tauri app packaging, GitHub Actions matrix builds, code signing, and release automation. After this phase, pushing a tag produces signed installers for Linux, macOS, and Windows.

## Prerequisites

- Phase 7 complete (app is feature-complete)
- Apple Developer Program account (for macOS signing/notarization)
- Windows code signing certificate (for SmartScreen trust)

## Deliverables

- **User-testable**: Download a release installer → install → first-run wizard → chat with web search. The complete end-user Haruspex experience on all three platforms.

---

## Tasks

### 8.1 llama-server build script (`scripts/build-llama-server.sh`)

Script to compile llama-server from source for each target:

```bash
#!/bin/bash
# Usage: ./scripts/build-llama-server.sh <target>
# Targets: linux-x64, windows-x64, macos-x64, macos-arm64
```

**Build matrix:**

| Target | GPU API | CMake flags | Output binary |
|---|---|---|---|
| `x86_64-unknown-linux-gnu` | Vulkan | `-DGGML_VULKAN=ON` | `llama-server-x86_64-unknown-linux-gnu` |
| `x86_64-pc-windows-msvc` | Vulkan | `-DGGML_VULKAN=ON` | `llama-server-x86_64-pc-windows-msvc.exe` |
| `x86_64-apple-darwin` | Metal | `-DGGML_METAL=ON` | `llama-server-x86_64-apple-darwin` |
| `aarch64-apple-darwin` | Metal | `-DGGML_METAL=ON` | `llama-server-aarch64-apple-darwin` |

**Implementation:**

- Clone `llama.cpp` at a pinned commit/tag (record in a `LLAMA_CPP_VERSION` file).
- Build with CMake.
- Strip debug symbols from the binary.
- Copy to `src-tauri/binaries/` with the correct Tauri target triple suffix.
- Verify the binary runs (`--help` exits 0).

### 8.2 Sidecar binary CI job

Separate GitHub Actions workflow to build sidecar binaries:

```yaml
# .github/workflows/build-sidecar.yml
name: Build llama-server sidecars
on:
  workflow_dispatch:
  push:
    paths: ['scripts/build-llama-server.sh', 'LLAMA_CPP_VERSION']

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: ubuntu-22.04
            target: x86_64-unknown-linux-gnu
            gpu: vulkan
          - os: windows-latest
            target: x86_64-pc-windows-msvc
            gpu: vulkan
          - os: macos-latest
            target: aarch64-apple-darwin
            gpu: metal
          - os: macos-13
            target: x86_64-apple-darwin
            gpu: metal
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - name: Install Vulkan SDK (Linux/Windows only)
        if: matrix.gpu == 'vulkan'
        # Install Vulkan SDK/headers
      - name: Build llama-server
        run: ./scripts/build-llama-server.sh ${{ matrix.target }}
      - uses: actions/upload-artifact@v4
        with:
          name: llama-server-${{ matrix.target }}
          path: src-tauri/binaries/llama-server-${{ matrix.target }}*
```

Store built binaries as release artifacts. Download them in the app build workflow.

### 8.3 Tauri app build workflow

```yaml
# .github/workflows/build.yml
name: Build App
on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    strategy:
      matrix:
        include:
          - platform: ubuntu-22.04
            args: ''
          - platform: windows-latest
            args: ''
          - platform: macos-latest
            args: '--target aarch64-apple-darwin'
          - platform: macos-13
            args: '--target x86_64-apple-darwin'
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: dtolnay/rust-toolchain@stable
      - name: Install Linux dependencies
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev
      - name: Download sidecar binary
        uses: actions/download-artifact@v4
        # Download the appropriate sidecar binary
      - run: npm ci
      - uses: tauri-apps/tauri-action@v0
        with:
          args: ${{ matrix.args }}
```

### 8.4 Release workflow

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  create-release:
    runs-on: ubuntu-latest
    outputs:
      release_id: ${{ steps.create.outputs.id }}
    steps:
      - uses: actions/checkout@v4
      - id: create
        uses: softprops/action-gh-release@v2
        with:
          draft: true
          generate_release_notes: true

  build-and-upload:
    needs: create-release
    strategy:
      matrix:
        include:
          - platform: ubuntu-22.04
            args: ''
          - platform: windows-latest
            args: ''
          - platform: macos-latest
            args: '--target aarch64-apple-darwin'
          - platform: macos-13
            args: '--target x86_64-apple-darwin'
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: dtolnay/rust-toolchain@stable
      - run: npm ci
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_PRIVATE_KEY }}
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERT }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERT_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: 'Haruspex ${{ github.ref_name }}'
          releaseId: ${{ needs.create-release.outputs.release_id }}
          args: ${{ matrix.args }}
```

### 8.5 Code signing setup

**macOS:**
- Import Apple Developer certificate into CI keychain.
- Configure notarization (Apple ID, app-specific password, team ID).
- Tauri handles notarization automatically via `tauri-action` when env vars are set.

**Windows:**
- Import code signing certificate (EV or OV).
- Configure `signtool` in the build pipeline.
- Tauri supports Windows signing via the `WINDOWS_CERTIFICATE` env vars.

**Linux:**
- GPG-sign `.deb` and `.rpm` packages (optional but recommended).
- Generate and host a GPG public key for package verification.

### 8.6 Tauri updater configuration

Configure Tauri's built-in updater for auto-updates:

```json
// tauri.conf.json
{
  "plugins": {
    "updater": {
      "active": true,
      "dialog": true,
      "endpoints": [
        "https://github.com/OWNER/haruspex/releases/latest/download/latest.json"
      ],
      "pubkey": "..."
    }
  }
}
```

- Generate signing keypair (`tauri signer generate`).
- Store private key as GitHub secret.
- `tauri-action` auto-generates `latest.json` manifest on release.

### 8.7 Installer configuration

**Linux:**
- `.deb` (Debian/Ubuntu): set dependencies (libwebkit2gtk, libvulkan1).
- `.rpm` (Fedora/RHEL): set dependencies.
- `.AppImage`: universal, no dependencies.

**macOS:**
- `.dmg` with drag-to-Applications background image.
- Universal binary if feasible (or separate x64/arm64 DMGs).

**Windows:**
- `.msi` installer via WiX (Tauri default).
- Set proper registry entries for uninstall.

### 8.8 Version management

- Use `npm version` to bump `package.json`.
- Sync version to `tauri.conf.json` and `Cargo.toml` via a script:

```bash
# scripts/bump-version.sh
VERSION=$1
npm version $VERSION --no-git-tag-version
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json
sed -i "s/^version = \".*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml
git add -A && git commit -m "chore: bump version to $VERSION"
git tag "v$VERSION"
```

### 8.9 Smoke test workflow

After building, run a basic smoke test:

- Launch the app in headless mode (Xvfb on Linux).
- Verify the window opens.
- Verify llama-server sidecar is present and executable.
- Verify the first-run wizard is accessible.

---

## Test Coverage

| Area | What to test | Tool |
|---|---|---|
| Build script | Produces correct binary name for each target | Shell test |
| Build script | Binary runs `--help` without error | Shell test |
| CI workflows | All matrix jobs complete successfully | GitHub Actions |
| Signing | macOS binary is signed and notarized | `codesign --verify` |
| Signing | Windows binary is signed | `signtool verify` |
| Updater | `latest.json` manifest is valid and URLs resolve | curl + jq |
| Installer | Linux .deb installs and launches on Ubuntu | Manual / VM |
| Installer | macOS .dmg mounts, app drags to Applications, launches | Manual / VM |
| Installer | Windows .msi installs, app launches from Start menu | Manual / VM |
| Smoke test | App launches in headless mode without crash | CI (Xvfb) |
| Version sync | All version files match after bump script | Shell test |

---

## Definition of Done

- [ ] `git tag v0.1.0 && git push --tags` → CI builds all platform installers
- [ ] macOS .dmg is signed and notarized (no Gatekeeper warning)
- [ ] Windows .msi is signed (no SmartScreen warning)
- [ ] Linux .deb/.AppImage installs and runs
- [ ] Auto-updater detects and installs a new version
- [ ] All installers include the correct llama-server sidecar binary
- [ ] Release is created as a draft on GitHub with all artifacts attached
- [ ] Smoke tests pass in CI
- [ ] Version number is consistent across package.json, Cargo.toml, and tauri.conf.json
