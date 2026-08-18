import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	getSettings: vi.fn(),
	updateSettings: vi.fn(),
	startRemoteDriver: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('$lib/stores/settings', () => ({
	getSettings: mocks.getSettings,
	updateSettings: mocks.updateSettings
}));
vi.mock('$lib/remote/driver', () => ({ startRemoteDriver: mocks.startRemoteDriver }));

import { syncRemoteServer } from '$lib/remote/service';
import { qrPath, remoteLink, generateRemoteToken } from '$lib/remote/api';

const RUNNING = { running: true, port: 8787, bindAll: true, sessions: 0 };
const STOPPED = { running: false, port: null, bindAll: false, sessions: 0 };

function settings(overrides: Record<string, unknown> = {}) {
	return {
		remoteAccessEnabled: true,
		remoteAccessPort: 8787,
		remoteAccessToken: 'a-token',
		...overrides
	};
}

function invocations(command: string) {
	return mocks.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);
}

beforeEach(() => {
	mocks.invoke.mockReset().mockResolvedValue(RUNNING);
	mocks.updateSettings.mockReset();
	mocks.startRemoteDriver.mockReset().mockResolvedValue(undefined);
	mocks.getSettings.mockReset().mockReturnValue(settings());
});

describe('turning remote access on and off', () => {
	it('starts nothing at all when the setting is off', async () => {
		mocks.getSettings.mockReturnValue(settings({ remoteAccessEnabled: false }));
		mocks.invoke.mockResolvedValue(STOPPED);

		await syncRemoteServer();
		expect(invocations('remote_stop')).toHaveLength(1);
		expect(invocations('remote_start')).toHaveLength(0);
		expect(mocks.startRemoteDriver).not.toHaveBeenCalled();
	});

	it('listens before it opens the port', async () => {
		await syncRemoteServer();
		// The other order would drop the first prompt through the door.
		expect(mocks.startRemoteDriver).toHaveBeenCalled();
		expect(invocations('remote_start')).toEqual([
			{ config: { port: 8787, token: 'a-token', bindAll: true } }
		]);
	});

	it('mints a token on first enable rather than at install time', async () => {
		mocks.getSettings.mockReturnValue(settings({ remoteAccessToken: '' }));
		await syncRemoteServer();

		const minted = mocks.updateSettings.mock.calls[0][0].remoteAccessToken;
		expect(minted).toMatch(/^[a-z0-9]{20}$/);
		// A secret with no owner is not created before anyone asks for remote
		// access, and the freshly minted one is what the server gets.
		expect(invocations('remote_start')[0].config.token).toBe(minted);
	});

	it('survives a port that is already taken', async () => {
		mocks.invoke.mockRejectedValue(new Error('address in use'));
		// Remote access stays off; the app does not come down with it.
		await expect(syncRemoteServer()).resolves.toBeNull();
	});
});

describe('the link the host hands out', () => {
	it('uses the LAN address, never localhost', () => {
		expect(remoteLink('192.168.1.50', 8787, 'abc')).toBe('http://192.168.1.50:8787/?t=abc');
	});

	it('escapes a token that would break the query string', () => {
		expect(remoteLink('10.0.0.2', 80, 'a+b/c')).toBe('http://10.0.0.2:80/?t=a%2Bb%2Fc');
	});

	it('mints tokens that are unguessable and URL-safe', () => {
		const tokens = new Set(Array.from({ length: 50 }, () => generateRemoteToken()));
		expect(tokens.size).toBe(50);
		for (const token of tokens) expect(token).toMatch(/^[a-z0-9]{20}$/);
	});

	it('draws the QR as one path rather than a thousand elements', () => {
		// A 2×2 with the top-left and bottom-right dark.
		const path = qrPath({ size: 2, modules: [true, false, false, true] });
		expect(path).toBe('M0 0h1v1h-1zM1 1h1v1h-1z');
	});
});
