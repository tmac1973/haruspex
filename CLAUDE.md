# Haruspex

Private local AI desktop app — Tauri 2.x + SvelteKit 5 + llama.cpp sidecar.

## Tech Stack

- **Frontend**: SvelteKit 5 (Svelte 5 runes, TypeScript, static adapter for SPA)
- **Backend**: Tauri 2.x (Rust)
- **Inference**: llama-server sidecar (OpenAI-compatible API)
- **Default model**: Granite 4.0 Micro (Q4_K_M, ~2.1 GB)

## Build Commands

```bash
npm run dev          # SvelteKit dev server (port 1420)
npm run build        # Build frontend
npm run check        # TypeScript / Svelte type checking
npm run lint         # ESLint
npm run format       # Prettier format
npm run format:check # Prettier check
npm run test         # Vitest (run once)
npm run test:watch   # Vitest (watch mode)
npm run tauri dev    # Full Tauri dev (frontend + Rust)
npm run tauri build  # Production build

# Rust (from src-tauri/)
cargo test           # Rust unit tests
cargo clippy         # Rust lints
cargo fmt -- --check # Rust format check
```

## Conventions

- SvelteKit SPA mode (SSR disabled, static adapter with `fallback: 'index.html'`)
- Svelte 5 runes mode everywhere
- Tabs for indentation, single quotes, no trailing commas (Prettier)
- Rust: 4-space indent, 100 char line width
- Tests co-located with source: `foo.ts` → `foo.test.ts`
