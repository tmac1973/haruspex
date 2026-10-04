import { defineConfig, devices } from '@playwright/test';

/**
 * UI flows in a real browser, with Tauri's IPC mocked (`src/lib/e2e/`) and the
 * model replaced by the scripted fake LLM (`e2e/fake-llm/`). See
 * docs/testing.md.
 */
export const APP_PORT = 1430;
export const FAKE_LLM_PORT = 18765;

export default defineConfig({
	testDir: 'e2e/ui',
	fullyParallel: false,
	// One fake LLM serves every test; its scenario is per test, so tests run
	// one at a time.
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
	use: {
		baseURL: `http://localhost:${APP_PORT}`,
		viewport: { width: 1280, height: 800 },
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002 } },
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }
		}
	],
	webServer: [
		{
			command: `node e2e/fake-llm/server.mjs --port ${FAKE_LLM_PORT}`,
			url: `http://127.0.0.1:${FAKE_LLM_PORT}/v1/models`,
			reuseExistingServer: !process.env.CI
		},
		{
			command: `npx vite dev --mode e2e --port ${APP_PORT} --strictPort`,
			url: `http://localhost:${APP_PORT}`,
			reuseExistingServer: !process.env.CI,
			timeout: 120_000
		}
	]
});
