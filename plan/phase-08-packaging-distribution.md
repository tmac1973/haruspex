# Phase 8: Packaging, CI/CD & Distribution

## Goal

Set up the full build pipeline: cross-platform sidecar compilation (llama-server, whisper-server, koko), Tauri app packaging, GitHub Actions matrix builds, optional code signing, and release automation. After this phase, pushing a tag produces installers for Linux, macOS, and Windows.

## Prerequisites

- All phases complete (app is feature-complete)
- GitHub repository with Actions enabled
- **Optional**: Apple Developer Program account (macOS signing/notarization)
- **Optional**: Windows code signing certificate (SmartScreen trust)
- Builds will fall back to unsigned installers if signing keys are not configured

## Deliverables

- **User-testable**: Download a release installer → install → first-run wizard → chat with web search and voice. The complete end-user Haruspex experience on all three platforms.

---

## Sidecar Binaries

Three sidecars must be built per platform:

| Sidecar | Source | Linux GPU | macOS GPU | Windows GPU |
|---|---|---|---|---|
| `llama-server` | llama.cpp | Vulkan | Metal | Vulkan |
| `whisper-server` | whisper.cpp | Vulkan | Metal | Vulkan |
| `koko` | Kokoros | CPU | CPU | CPU |

All use the Tauri target triple suffix naming convention:
- `llama-server-x86_64-unknown-linux-gnu`
- `whisper-server-aarch64-apple-darwin`
- `koko-x86_64-pc-windows-msvc.exe`

---

## Tasks

### 8.1 Sidecar build script (`scripts/build-sidecars.sh`)

Single script that builds all three sidecars for a given target:

```bash
#!/bin/bash
# Usage: ./scripts/build-sidecars.sh [--target <triple>]
# Defaults to host target triple if not specified
```

For each sidecar:
- Clone repo at a pinned version (recorded in version files)
- Build with CMake (llama.cpp, whisper.cpp) or Cargo (Kokoros)
- Strip debug symbols
- Copy binary + shared libs to `src-tauri/binaries/`
- Verify binary runs (`--help` or `--version`)

Version pinning files:
- `LLAMA_CPP_VERSION` (e.g., `b8570`)
- `WHISPER_CPP_VERSION` (e.g., `v1.8.4`)
- `KOKOROS_VERSION` (e.g., `main` or a commit hash)

### 8.2 Sidecar CI workflow

```yaml
# .github/workflows/build-sidecars.yml
name: Build Sidecars
on:
  workflow_dispatch:
  workflow_call:

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: ubuntu-22.04
            target: x86_64-unknown-linux-gnu
          - os: windows-latest
            target: x86_64-pc-windows-msvc
          - os: macos-latest
            target: aarch64-apple-darwin
          - os: macos-13
            target: x86_64-apple-darwin
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - name: Install Vulkan SDK (Linux)
        if: runner.os == 'Linux'
        run: sudo apt-get install -y libvulkan-dev
      - name: Install Vulkan SDK (Windows)
        if: runner.os == 'Windows'
        uses: jakoch/install-vulkan-sdk-action@v1
      - name: Build sidecars
        run: ./scripts/build-sidecars.sh --target ${{ matrix.target }}
      - uses: actions/upload-artifact@v4
        with:
          name: sidecars-${{ matrix.target }}
          path: src-tauri/binaries/
```

### 8.3 App build + release workflow

Combined workflow: build sidecars, then build Tauri app:

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  build-sidecars:
    uses: ./.github/workflows/build-sidecars.yml

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

  build-app:
    needs: [build-sidecars, create-release]
    strategy:
      matrix:
        include:
          - platform: ubuntu-22.04
            target: x86_64-unknown-linux-gnu
            args: ''
          - platform: windows-latest
            target: x86_64-pc-windows-msvc
            args: ''
          - platform: macos-latest
            target: aarch64-apple-darwin
            args: '--target aarch64-apple-darwin'
          - platform: macos-13
            target: x86_64-apple-darwin
            args: '--target x86_64-apple-darwin'
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: dtolnay/rust-toolchain@stable
      - name: Install Linux dependencies
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libasound2-dev
      - name: Download sidecars
        uses: actions/download-artifact@v4
        with:
          name: sidecars-${{ matrix.target }}
          path: src-tauri/binaries/
      - run: npm ci
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # Code signing — optional, builds unsigned if not set
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_PRIVATE_KEY || '' }}
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERT || '' }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERT_PASSWORD || '' }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY || '' }}
          APPLE_ID: ${{ secrets.APPLE_ID || '' }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD || '' }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID || '' }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: 'Haruspex ${{ github.ref_name }}'
          releaseId: ${{ needs.create-release.outputs.release_id }}
          args: ${{ matrix.args }}
```

### 8.4 Code signing (optional)

Signing env vars are passed but default to empty strings. Tauri skips signing when keys are not provided.

**When ready to sign:**
- **macOS**: Add `APPLE_CERT`, `APPLE_CERT_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` as GitHub secrets
- **Windows**: Add `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` as GitHub secrets
- **Tauri updater**: Generate keypair with `tauri signer generate`, add `TAURI_PRIVATE_KEY` as secret

### 8.5 Installer configuration

**Linux:**
- `.deb`: dependencies — libwebkit2gtk-4.1, libvulkan1, libasound2
- `.AppImage`: universal, no dependencies
- `.rpm`: dependencies — webkit2gtk4.1, vulkan-loader, alsa-lib

**macOS:**
- `.dmg` per architecture (arm64, x64)
- Unsigned builds show "unidentified developer" warning (user right-clicks → Open)

**Windows:**
- `.msi` via WiX (Tauri default) or `.nsis` installer
- Unsigned builds trigger SmartScreen warning (user clicks "More info" → "Run anyway")

### 8.6 Version management

```bash
# scripts/bump-version.sh
VERSION=$1
npm version $VERSION --no-git-tag-version
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json
sed -i "s/^version = \".*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml
git add -A && git commit -m "chore: bump version to $VERSION"
git tag "v$VERSION"
```

### 8.7 CI lint/test workflow (existing, updated)

Keep the existing `.github/workflows/ci.yml` for PRs and pushes. Add sidecar placeholder binaries so Tauri compiles in CI without real sidecars.

---

## Definition of Done

- [ ] `git tag v0.1.0 && git push --tags` → CI builds all platform installers
- [ ] Linux .deb/.AppImage installs and runs
- [ ] macOS .dmg opens and app launches (unsigned OK for now)
- [ ] Windows .msi installs and app launches (unsigned OK for now)
- [ ] All installers include llama-server, whisper-server, and koko sidecars
- [ ] Release is created as a draft on GitHub with all artifacts
- [ ] Version number is consistent across package.json, Cargo.toml, and tauri.conf.json
- [ ] Signing works when keys are provided, falls back gracefully when not
