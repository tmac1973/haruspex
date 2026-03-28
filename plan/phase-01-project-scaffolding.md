# Phase 1: Project Scaffolding & Dev Tooling

## Goal

Stand up the Tauri 2.x + SvelteKit 5 project skeleton with dev tooling, linting, testing infrastructure, and a CI lint/check pipeline. No user-facing functionality yet — this phase produces a buildable, testable, well-structured empty shell.

## Deliverables

- Runnable Tauri dev shell (`cargo tauri dev` opens a window)
- Linting & formatting configured (Rust + TypeScript)
- Unit test harnesses wired for both sides (Vitest + `cargo test`)
- CI pipeline: lint, format-check, typecheck, unit tests
- Repository hygiene: `.gitignore`, `LICENSE`, `CLAUDE.md`

---

## Tasks

### 1.1 Scaffold the Tauri + SvelteKit project

```bash
npm create tauri-app@latest haruspex -- --template svelte-ts
```

After scaffolding:

- Verify `cargo tauri dev` opens a blank window with the SvelteKit dev server.
- Pin dependency versions in `package.json` (exact versions, no `^`).
- Add `"type": "module"` to `package.json` if not already present.
- Update `tauri.conf.json`:
  - Set `identifier` to `com.haruspex.app`
  - Set `title` to `Haruspex`
  - Set `windows[0].title` to `Haruspex`

### 1.2 Establish directory structure

Create the directory tree from the architecture doc (empty files with TODO comments where implementation will go):

```
src/lib/components/       # Svelte components
src/lib/stores/           # Svelte stores
src/lib/agent/            # Agent loop logic
src/lib/api.ts            # llama-server client wrapper
src/routes/               # SvelteKit routes (layout, main page, setup)
src-tauri/src/            # Rust modules (main.rs, server.rs, proxy.rs, models.rs)
src-tauri/binaries/       # Sidecar binaries (gitignored, with .gitkeep)
scripts/                  # Build helper scripts
```

### 1.3 Configure TypeScript tooling

- **Vitest**: Install and configure with `vitest.config.ts`. Set up path aliases matching SvelteKit's `$lib`.
- **ESLint**: `@eslint/js` + `typescript-eslint` + `eslint-plugin-svelte`. Flat config format.
- **Prettier**: With `prettier-plugin-svelte`. Add `.prettierrc`.
- **TypeScript**: Strict mode enabled. Ensure `tsconfig.json` covers both `src/` and test files.

Add npm scripts:

```json
{
  "scripts": {
    "dev": "tauri dev",
    "build": "tauri build",
    "check": "svelte-check --tsconfig ./tsconfig.json",
    "lint": "eslint src/",
    "format": "prettier --write src/",
    "format:check": "prettier --check src/",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

### 1.4 Configure Rust tooling

- Add `clippy` and `rustfmt` checks.
- Create `src-tauri/rustfmt.toml` with project defaults (e.g., `edition = "2021"`).
- Add a basic `#[cfg(test)]` module in `main.rs` with a passing placeholder test.
- Ensure `cargo test` passes from `src-tauri/`.
- Add Rust module stubs:
  - `server.rs` — `pub mod` declaration, empty struct `LlamaServer`
  - `proxy.rs` — `pub mod` declaration
  - `models.rs` — `pub mod` declaration

### 1.5 CI pipeline (GitHub Actions)

Create `.github/workflows/ci.yml`:

```yaml
name: CI
on: [push, pull_request]

jobs:
  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run lint
      - run: npm run format:check
      - run: npm run check
      - run: npm run test

  backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { components: 'clippy, rustfmt' }
      - run: cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
      - run: cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
      - run: cargo test --manifest-path src-tauri/Cargo.toml
```

### 1.6 Repository hygiene

- `.gitignore`: node_modules, target, dist, .tauri, sidecar binaries, `.env*`, OS files.
- `LICENSE`: MIT (or chosen license).
- `CLAUDE.md`: Project context for AI-assisted development — tech stack, build commands, conventions.

---

## Test Coverage

| Area | What to test | Tool |
|---|---|---|
| Scaffold | `cargo tauri dev` launches without error | Manual |
| TypeScript | Placeholder Vitest test passes (`npm run test`) | Vitest |
| Rust | Placeholder `cargo test` passes | cargo test |
| Lint | `npm run lint` exits 0 on clean code | ESLint |
| Format | `npm run format:check` exits 0 | Prettier |
| Typecheck | `npm run check` exits 0 | svelte-check |
| CI | All jobs green on push | GitHub Actions |

---

## Definition of Done

- [ ] `cargo tauri dev` opens a window showing the SvelteKit default page
- [ ] All npm scripts (`lint`, `format:check`, `check`, `test`) pass
- [ ] `cargo test`, `cargo clippy`, `cargo fmt --check` pass
- [ ] CI pipeline runs and passes on push
- [ ] Directory structure matches architecture doc
- [ ] No warnings from any linter
