import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL, seed, stubPid, alive, appPid } from '../helpers.mjs';
import { e2eDataDirs } from '../wdio.conf.mjs';
import { STUB_PIDS, appBinary } from '../paths.mjs';

/**
 * Phase 13's guarantee: a sidecar dies with the app, however the app ends.
 * Local mode with a stub model file makes the app start "haruspex-llama-server" (the
 * stub from e2e/sidecar-stub); then the app is killed outright — SIGKILL,
 * TerminateProcess — which no exit handler survives.
 */
describe('sidecars die with the app', () => {
	it('stops the model server within 2 s of the app being killed', async () => {
		const models = join(e2eDataDirs()[0], 'models');
		mkdirSync(models, { recursive: true });
		writeFileSync(join(models, 'e2e-stub.gguf'), 'not a real model');
		// Only a server started from here on counts.
		rmSync(join(STUB_PIDS, 'haruspex-llama-server.pid'), { force: true });
		await seed(LOCAL);

		// The recorded pid can belong to a server that is already gone: one the
		// app stopped and started again (a reload while seeding, a health check
		// a busy machine timed out), or one that could not take the port. Wait
		// for one that is running and is this app's child.
		let server = null;
		let app = null;
		await browser.waitUntil(
			async () => {
				server = stubPid(STUB_PIDS, 'haruspex-llama-server');
				app = server !== null && alive(server) ? await appPid(appBinary(), server) : null;
				return app !== null;
			},
			{
				timeout: 30_000,
				timeoutMsg: 'the app never had a model server of its own running'
			}
		);
		process.kill(app, 'SIGKILL');

		const deadline = Date.now() + 2_000;
		while (alive(server) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		if (alive(server)) process.kill(server, 'SIGKILL');
		expect({ serverAliveAfterAppKilled: alive(server) }).toEqual({
			serverAliveAfterAppKilled: false
		});
	});
});
