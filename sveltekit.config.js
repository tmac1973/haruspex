// SvelteKit's configuration, passed to the `sveltekit(...)` Vite plugin by
// both vite.config.ts and vitest.config.ts. (SvelteKit 3 no longer reads a
// svelte.config.js.)
import adapter from '@sveltejs/adapter-static';
import { relative, sep } from 'node:path';

/** @type {import('@sveltejs/kit/vite').Config} */
const config = {
	compilerOptions: {
		runes: ({ filename }) => {
			const relativePath = relative(import.meta.dirname, filename);
			const pathSegments = relativePath.toLowerCase().split(sep);
			const isExternalLibrary = pathSegments.includes('node_modules');
			return isExternalLibrary ? undefined : true;
		}
	},
	adapter: adapter({
		fallback: 'index.html'
	})
};

export default config;
