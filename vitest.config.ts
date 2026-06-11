import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';

export default defineConfig({
	// svelteTesting() resolves Svelte to its client (browser) build under
	// jsdom — without it component mount() fails with SSR lifecycle errors —
	// and auto-cleans the DOM between tests.
	plugins: [sveltekit(), svelteTesting()],
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'jsdom',
		globals: true
	}
});
