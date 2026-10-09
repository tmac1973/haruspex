#!/usr/bin/env node
/**
 * Build the app for the real-app tests: a debug build with the e2e identifier,
 * in its own target dir, with every sidecar replaced by the stub in
 * e2e/sidecar-stub (it answers health checks and records its pid).
 *
 *   node e2e/app/build.mjs            build, then swap in the stubs
 *   node e2e/app/build.mjs --stubs    only (re)compile and swap in the stubs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN_DIR, E2E_ID, ROOT, SIDECARS, TARGET, appBinary, stubBinary } from './paths.mjs';

const run = (cmd, args, env = {}) =>
	execFileSync(cmd, args, {
		cwd: ROOT,
		stdio: 'inherit',
		env: { ...process.env, ...env },
		shell: process.platform === 'win32'
	});

/**
 * The test build's config, made from tauri.conf.json at build time so it
 * cannot drift: its own identifier, and the windows without
 * `additionalBrowserArgs`. Those arguments override
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, which is how msedgedriver gives
 * WebView2 its --remote-debugging-port; with them, no WebDriver session can
 * start on Windows. (They only stop background throttling.) A file, not
 * inline JSON: on Windows npm runs through a shell, which mangles quotes.
 */
function e2eConfig() {
	const base = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
	const windows = (base.app?.windows ?? []).map((w) => {
		const copy = { ...w };
		delete copy.additionalBrowserArgs;
		return copy;
	});
	const file = join(TARGET, 'tauri.e2e.conf.json');
	mkdirSync(TARGET, { recursive: true });
	writeFileSync(file, JSON.stringify({ identifier: E2E_ID, app: { windows } }, null, '\t') + '\n');
	return file;
}

if (!process.argv.includes('--stubs')) {
	run('npm', ['run', 'tauri', 'build', '--', '--debug', '--no-bundle', '--config', e2eConfig()], {
		CARGO_TARGET_DIR: TARGET,
		// The frontend carries the hooks scripts/drive.mjs reads (src/hooks.client.ts).
		VITE_HARUSPEX_E2E: '1'
	});
}
if (!existsSync(appBinary()))
	throw new Error(`no app at ${appBinary()} — the build did not produce it`);

mkdirSync(TARGET, { recursive: true });
run('rustc', ['-O', join('e2e', 'sidecar-stub', 'main.rs'), '-o', stubBinary()]);
for (const name of SIDECARS) {
	copyFileSync(stubBinary(), join(BIN_DIR, name));
	console.log(`stubbed ${name}`);
}
