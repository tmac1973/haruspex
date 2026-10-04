/**
 * The built app, driven through WebDriver: tauri-driver in front of
 * WebKitWebDriver (Linux) or msedgedriver (Windows). See docs/testing.md.
 *
 * Build first with `npm run e2e:app:build`; `npm run e2e:app` runs the specs.
 * Each spec file gets a fresh app with the e2e identifier's data wiped, so
 * nothing carries over and the user's own Haruspex data is never touched.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appBinary, E2E_ID, ROOT, STUB_PIDS } from './paths.mjs';
import { createFakeLlm } from '../fake-llm/server.mjs';

const isWindows = process.platform === 'win32';
/** Screenshots of failed tests; CI uploads it. */
const OUTPUT = join(ROOT, 'e2e', 'app', 'output');

/** The e2e identifier's folders: app data, WebView storage, caches. */
export function e2eDataDirs() {
	if (isWindows) {
		return [process.env.APPDATA, process.env.LOCALAPPDATA]
			.filter(Boolean)
			.map((d) => join(d, E2E_ID));
	}
	return [
		join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), E2E_ID),
		join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), E2E_ID),
		join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), E2E_ID)
	];
}

let tauriDriver;
let fakeLlm;

export const config = {
	runner: 'local',
	hostname: '127.0.0.1',
	port: 4444,
	specs: ['./specs/*.e2e.mjs'],
	maxInstances: 1,
	capabilities: [
		{
			maxInstances: 1,
			'tauri:options': { application: appBinary() }
		}
	],
	logLevel: 'warn',
	reporters: ['spec'],
	framework: 'mocha',
	mochaOpts: { ui: 'bdd', timeout: 120_000 },
	waitforTimeout: 15_000,

	onPrepare: async () => {
		fakeLlm = createFakeLlm({ scenario: 'chat-hello' });
		await fakeLlm.listen();
	},
	onComplete: async () => {
		await fakeLlm?.close();
	},

	beforeSession: () => {
		for (const dir of e2eDataDirs()) rmSync(dir, { recursive: true, force: true });
		rmSync(STUB_PIDS, { recursive: true, force: true });
		mkdirSync(STUB_PIDS, { recursive: true });
		const args = [];
		if (isWindows && process.env.MSEDGEDRIVER)
			args.push('--native-driver', process.env.MSEDGEDRIVER);
		tauriDriver = spawn(process.env.TAURI_DRIVER ?? 'tauri-driver', args, {
			stdio: [null, process.stdout, process.stderr],
			// Inherited by the app, and by every sidecar it starts.
			env: { ...process.env, E2E_STUB_PIDS: STUB_PIDS }
		});
		// tauri-driver listens on 4444 once it is up.
		return new Promise((resolve) => setTimeout(resolve, 1500));
	},
	/** On failure: a screenshot of the app, for the CI artifact. */
	afterTest: async (test, _context, { passed }) => {
		if (passed) return;
		mkdirSync(OUTPUT, { recursive: true });
		const name = `${test.parent} - ${test.title}`.replace(/[^a-z0-9 -]+/gi, '_');
		try {
			await browser.saveScreenshot(join(OUTPUT, `${name}.png`));
		} catch {
			// The app is gone (the sidecar spec kills it); nothing to capture.
		}
	},
	afterSession: () => {
		tauriDriver?.kill();
	}
};
