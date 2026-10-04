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
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BIN_DIR, ROOT, SIDECARS, TARGET, appBinary, stubBinary } from './paths.mjs';

const run = (cmd, args, env = {}) =>
	execFileSync(cmd, args, {
		cwd: ROOT,
		stdio: 'inherit',
		env: { ...process.env, ...env },
		shell: process.platform === 'win32'
	});

if (!process.argv.includes('--stubs')) {
	run(
		'npm',
		[
			'run',
			'tauri',
			'build',
			'--',
			'--debug',
			'--no-bundle',
			'--config',
			// A file, not inline JSON: on Windows npm runs through a shell,
			// which would mangle the quotes.
			join('e2e', 'app', 'tauri.e2e.conf.json')
		],
		{ CARGO_TARGET_DIR: TARGET }
	);
}
if (!existsSync(appBinary()))
	throw new Error(`no app at ${appBinary()} — the build did not produce it`);

mkdirSync(TARGET, { recursive: true });
run('rustc', ['-O', join('e2e', 'sidecar-stub', 'main.rs'), '-o', stubBinary()]);
for (const name of SIDECARS) {
	copyFileSync(stubBinary(), join(BIN_DIR, name));
	console.log(`stubbed ${name}`);
}
