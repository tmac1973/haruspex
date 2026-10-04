/** Steps shared by the real-app specs. Uses WebdriverIO's global `browser`. */
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_PORT } from '../fake-llm/server.mjs';

export const FAKE_LLM = `http://127.0.0.1:${DEFAULT_PORT}`;

/** Remote mode at the fake LLM: no local server, no first-run wizard. */
export const REMOTE = {
	dismissedStartupNotice: true,
	inferenceBackend: {
		mode: 'remote',
		remoteBaseUrl: FAKE_LLM,
		remoteServerUrls: [FAKE_LLM],
		remoteModelId: 'fake-model',
		remoteContextSize: 32768,
		remoteVisionSupported: false,
		remoteBackendKind: 'generic'
	}
};

/** Local mode, as a fresh install has it, without the startup notice. */
export const LOCAL = { dismissedStartupNotice: true };

export async function useScenario(name) {
	const r = await fetch(`${FAKE_LLM}/__scenario`, {
		method: 'POST',
		body: JSON.stringify({ name })
	});
	if (!r.ok) throw new Error(`fake LLM refused scenario ${name}: ${await r.text()}`);
}

/**
 * Write the settings the app reads at load, then start it over at the root.
 * A first launch sends a fresh install to /setup, and the layout starts no
 * server while it is there, so this always lands on /.
 */
export async function seed(settings) {
	await browser.waitUntil(
		async () => (await browser.execute(() => document.readyState)) === 'complete',
		{ timeout: 30_000, timeoutMsg: 'the app window never finished loading' }
	);
	await browser.execute((s) => {
		localStorage.clear();
		localStorage.setItem('haruspex-settings', JSON.stringify(s));
		location.replace('/');
	}, settings);
	await browser.pause(500);
	await browser.waitUntil(
		async () => (await browser.execute(() => document.readyState)) === 'complete',
		{ timeout: 30_000, timeoutMsg: 'the app did not come back after seeding' }
	);
}

/** Send a chat message from the composer. */
export async function sendChat(text) {
	const input = await $('textarea[placeholder^="Type a message"]');
	await input.waitForEnabled({ timeout: 30_000 });
	await input.setValue(text);
	await browser.keys('Enter');
}

/** An element whose text contains `text`. */
export function byText(text) {
	return $(
		`//*[contains(normalize-space(.), ${JSON.stringify(text)}) and not(*[contains(normalize-space(.), ${JSON.stringify(text)})])]`
	);
}

/** The pid a stub sidecar recorded, or null if it has not started. */
export function stubPid(dir, name) {
	const file = `${dir}/${name}.pid`;
	return existsSync(file) ? Number(readFileSync(file, 'utf8')) : null;
}

/** Is a process alive? (Signal 0 tests without signalling, on Windows too.) */
export function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * The pid of the running test build, found by its executable path — never by
 * name, so the user's own Haruspex can never be the one killed.
 */
export async function appPid(binary) {
	const { readdirSync, readlinkSync } = await import('node:fs');
	const { execFileSync } = await import('node:child_process');
	if (process.platform === 'win32') {
		const out = execFileSync(
			'powershell',
			[
				'-NoProfile',
				'-Command',
				`(Get-Process | Where-Object { $_.Path -eq '${binary.replace(/'/g, "''")}' } | Select-Object -First 1).Id`
			],
			{ encoding: 'utf8' }
		).trim();
		return out ? Number(out) : null;
	}
	for (const entry of readdirSync('/proc')) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			if (readlinkSync(`/proc/${entry}/exe`) === binary) return Number(entry);
		} catch {
			// Not ours to read, or gone.
		}
	}
	return null;
}
