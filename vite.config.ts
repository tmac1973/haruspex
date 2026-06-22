import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';

// Phase 11 sandbox: SvelteKit's Vite plugin handles HTML responses itself
// and ignores Vite's `server.headers` config, so we need a middleware that
// runs before SvelteKit's handler and sets COOP/COEP on every dev-server
// response. Without these, crossOriginIsolated is false and the worker's
// cooperative interrupt path can't allocate a SharedArrayBuffer.
// Production headers live in src-tauri/tauri.conf.json.
const isolationHeaders = (): Plugin => ({
	name: 'haruspex-isolation-headers',
	configureServer(server) {
		server.middlewares.use((_req, res, next) => {
			res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
			res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
			next();
		});
	}
});

export default defineConfig({
	plugins: [isolationHeaders(), sveltekit()],
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		// `tauri dev` runs cargo concurrently with this dev server, constantly
		// writing and locking artifacts under src-tauri/target. On Windows,
		// Vite's file watcher throws EBUSY when it tries to watch one of those
		// locked build-script .exe files and crashes the whole dev server
		// ("beforeDevCommand terminated with a non-zero status code"). Exclude
		// the Rust crate dir from the watcher — nothing under src-tauri is a
		// frontend source anyway. (Standard Tauri + Vite guidance.)
		watch: {
			ignored: ['**/src-tauri/**']
		}
	},
	// The Python sandbox worker (python.worker.ts) loads pyodide, which Rollup
	// splits into multiple chunks. Vite's default worker format is `iife`,
	// which can't represent a multi-chunk bundle and fails the build with
	// "UMD and IIFE output formats are not supported for code-splitting".
	// The worker is already declared as `{ type: 'module' }` at the call site,
	// so emitting it as ES keeps runtime + build aligned.
	worker: {
		format: 'es'
	}
});
