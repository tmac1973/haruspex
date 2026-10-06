import { mkdirSync, writeFileSync } from 'node:fs';
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
		await seed(LOCAL);

		let server = null;
		await browser.waitUntil(() => (server = stubPid(STUB_PIDS, 'haruspex-llama-server')) !== null, {
			timeout: 30_000,
			timeoutMsg: 'the app never started its model server'
		});
		expect(alive(server)).toBe(true);

		const app = await appPid(appBinary(), server);
		expect(app).not.toBeNull();
		process.kill(app, 'SIGKILL');

		const deadline = Date.now() + 2_000;
		while (alive(server) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		if (alive(server)) process.kill(server, 'SIGKILL');
		expect({ serverAliveAfterAppKilled: alive(server) }).toEqual({
			serverAliveAfterAppKilled: false
		});
	});
});
