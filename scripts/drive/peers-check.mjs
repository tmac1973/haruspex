/**
 * Two Haruspex side by side (plan/instance-sync/ phase 13): A with Remote
 * control on, and B following it as one of its other computers. B starts a
 * Code session on A, answers the command prompt it asks in B's own dialog,
 * carries on a chat there, sees A go offline and come back, and stops
 * trusting A when A's certificate changes. Both run the e2e build against
 * the fake model, so nothing starts a sidecar.
 *
 * `npm run drive -- peers-check` after `npm run e2e:app:build`. Linux only:
 * the second app gets its own XDG directories.
 */
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { App, cleanup, fixtureCopy } from './app.mjs';

const SCENARIO = 'peers';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns something truthy, or fail saying `what`. */
async function until(what, fn, timeoutMs = 60_000) {
	const end = Date.now() + timeoutMs;
	let last;
	while (Date.now() < end) {
		try {
			last = await fn();
			if (last) return last;
		} catch (e) {
			last = e;
		}
		await sleep(500);
	}
	throw new Error(`timed out waiting for ${what} (last: ${last?.message ?? JSON.stringify(last)})`);
}

/** The text of what `selector` finds in an app's window, or null. */
function text(app, selector) {
	return app.exclusive(async (browser) => {
		const el = await browser.$(selector);
		return (await el.isExisting()) ? await el.getText() : null;
	});
}

export async function peersCheck({ outDir, show = false, log = console.log }) {
	const base = { fake: SCENARIO, autoApprove: false, show, verbosePayloads: false };
	const a = new App({ ...base, instance: 'a', api: true, outDir: join(outDir, 'a') }, (m) =>
		log(`[a] ${m}`)
	);
	const b = new App({ ...base, instance: 'b', outDir: join(outDir, 'b') }, (m) => log(`[b] ${m}`));
	const steps = [];
	const step = async (name, fn) => {
		log(`— ${name}`);
		const started = Date.now();
		await fn();
		steps.push({ name, ms: Date.now() - started });
	};
	try {
		await step('start A with Remote control on, letting the local network in', async () => {
			await a.start();
			await a.access('lan');
		});

		let peer;
		await step('start B and trust A by its fingerprint', async () => {
			const health = await (await a.apiFetch(`${a.api.base}/api/v1/health`)).json();
			peer = {
				instanceId: health.instanceId,
				name: health.name,
				address: '127.0.0.1',
				port: Number(new URL(a.api.base).port),
				fingerprint: new X509Certificate(a.api.certificate).fingerprint256,
				auth: 'trusted'
			};
			await b.start();
			await b.call('setPeers', [peer]);
			await until(
				'B to connect to A',
				async () => (await b.call('peerStatus', peer.instanceId)) === 'open'
			);
		});

		await step('no sidecar ports in use', async () => {
			const listening = execFileSync('ss', ['-ltn'], { encoding: 'utf8' });
			for (const port of [8765, 8766, 8767]) {
				if (listening.includes(`:${port} `)) throw new Error(`something listens on ${port}`);
			}
		});

		const section = `section[aria-label="On ${peer.name}"]`;
		let viewId;
		let sessionId;
		await step("B starts a session on A, and lists it under A's name", async () => {
			viewId = await b.call('peerStartSession', peer.instanceId, fixtureCopy());
			sessionId = viewId.split(':').at(-1);
			await until('the session under On A', async () => (await text(b, section)) !== null);
		});

		await step(
			"A's command prompt opens in B's dialog, labelled On A, and B allows it",
			async () => {
				await b.call('peerSend', viewId, 'clean the build folder');
				const origin = await until('the dialog on B', () =>
					text(b, '[data-testid="prompt-origin"]')
				);
				if (origin.trim() !== `On ${peer.name}`) throw new Error(`the dialog says ${origin}`);
				await b.click('button*=Allow once');
			}
		);

		await step('the turn finishes on A, and B shows what A has', async () => {
			const done = await until(
				'the turn on A',
				async () => {
					const s = await a.engine({ type: 'session.get', id: sessionId });
					const last = [...s.messages].reverse().find((m) => m.role === 'assistant');
					return !s.busy && last?.content === 'Removed the build folder.' ? s : null;
				},
				120_000
			);
			await until('B to show the same answer', async () => {
				const seen = await b.call('peerSession', viewId);
				return seen && !seen.busy && seen.lastAssistant === 'Removed the build folder.';
			});
			const check = await a.consistent(sessionId);
			if (!check.consistent)
				throw new Error(`A's events don't rebuild its session: ${JSON.stringify(check)}`);
			log(`  ${done.messages.length} messages on A, consistent`);
		});

		await step('B carries on a chat on A, and sees the answer', async () => {
			await b.call('peerOpenChat', peer.instanceId, 'new');
			await b.call('peerChatSend', 'hello');
			await until('the chat answer on B', async () => {
				const chat = await b.call('peerChat');
				return chat && !chat.busy && chat.lastAssistant?.includes('other computer');
			});
		});

		await step("A goes away: B shows A's sessions greyed, offline", async () => {
			// Past the 2 s B waits before keeping A's lists.
			await sleep(3000);
			await a.close();
			await until('B to see A offline', async () => (await text(b, section))?.includes('offline'));
		});

		await step('A comes back: B reconnects by itself', async () => {
			await a.start({ keep: true });
			await a.access('lan');
			await until(
				'B to reconnect',
				async () => (await b.call('peerStatus', peer.instanceId)) === 'open',
				90_000
			);
		});

		await step("A's certificate changes: B stops trusting it", async () => {
			await a.close();
			rmSync(join(a.appDataDir(), 'owner-tls.json'), { force: true });
			await a.start({ keep: true });
			await a.access('lan');
			await until(
				'B to see the certificate changed',
				async () => (await b.call('peerStatus', peer.instanceId)) === 'certificateChanged',
				90_000
			);
		});
		return { ok: true, steps };
	} finally {
		await a.close().catch(() => {});
		await b.close().catch(() => {});
		cleanup();
	}
}
