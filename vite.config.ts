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
		strictPort: true
	}
});
