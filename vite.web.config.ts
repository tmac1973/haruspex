/**
 * The web client (src/web/, plan/remote-api phase 4): a plain Svelte app, not
 * a second SvelteKit build, served by the owner API at /app/. It imports
 * `#lib/...` like the desktop app. The output is bundled with the desktop app
 * as the `web-client/` resource (tauri.conf.json).
 *
 *   npm run build:web    build into src-tauri/web-client/
 *   npm run dev:web      dev server on 1430, /api proxied to the owner API on 8788
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';

const OUT = resolve(import.meta.dirname, 'src-tauri/web-client');

/** The folder stays in git (tauri-build wants the resource); emptying it drops this. */
const keepPlaceholder = (): Plugin => ({
	name: 'haruspex-web-keep-placeholder',
	closeBundle() {
		writeFileSync(resolve(OUT, '.gitkeep'), '');
	}
});

export default defineConfig({
	root: resolve(import.meta.dirname, 'src/web'),
	base: '/app/',
	plugins: [svelte({ compilerOptions: { runes: true } }), keepPlaceholder()],
	clearScreen: false,
	build: {
		outDir: OUT,
		emptyOutDir: true
	},
	server: {
		port: 1430,
		strictPort: true,
		proxy: { '/api': 'http://127.0.0.1:8788' }
	}
});
