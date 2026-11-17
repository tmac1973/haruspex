import { describe, it, expect, vi, beforeEach } from 'vitest';

const flag = vi.hoisted(() => ({ ready: true }));
vi.mock('#lib/peers/flag.ts', () => ({
	get PEERS_READY() {
		return flag.ready;
	}
}));
vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { invoke } from '@tauri-apps/api/core';
import { invokeArgs, invokeCalls, invokeRouter } from '#lib/testing/invoke.ts';
import { getSettings, updateSettings } from '#lib/stores/settings.ts';
import {
	applyPeers,
	checkPeer,
	groupFingerprint,
	refusePeer,
	removePeer,
	resetPeersForTest,
	setPeerToken,
	trustPeer,
	type PeerProbe
} from './service.ts';

const OURS = '11111111-2222-3333-4444-555555555555';
const DESK = '6f9619ff-8b86-4011-b42d-00c04fc964ff';

function probe(over: Partial<PeerProbe> = {}): PeerProbe {
	return {
		instanceId: DESK,
		name: 'desk-pc',
		version: '0.2.18',
		fingerprint: 'AA:BB',
		address: '192.168.1.20',
		port: 8788,
		...over
	};
}

/** `peer_probe` answers from `answers` by address; an address with none fails. */
function route(answers: Record<string, PeerProbe>) {
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			instance_identity: { id: OURS, name: 'laptop' },
			peer_probe: (args) => {
				const a = answers[(args as { address: string }).address];
				if (!a) throw 'offline';
				return a;
			}
		})
	);
}

beforeEach(() => {
	flag.ready = true;
	vi.mocked(invoke).mockReset();
	route({});
	resetPeersForTest();
	updateSettings({ peersEnabled: true, peers: [], refusedPeers: [] });
});

describe('peers service', () => {
	it('tells Rust the feature is off while the build flag is', async () => {
		await applyPeers();
		expect(invokeArgs(vi.mocked(invoke), 'peers_apply', -1)).toEqual({
			config: { enabled: true, peers: [] }
		});
		flag.ready = false;
		await applyPeers();
		expect(invokeArgs(vi.mocked(invoke), 'peers_apply', -1)).toEqual({
			config: { enabled: false, peers: [] }
		});
	});

	it('trusts a computer as plain settings and forgets an earlier refusal', async () => {
		refusePeer(DESK);
		expect(getSettings().refusedPeers).toEqual([DESK]);
		await trustPeer(probe());
		const s = getSettings();
		expect(s.peers).toEqual([
			{
				instanceId: DESK,
				name: 'desk-pc',
				address: '192.168.1.20',
				port: 8788,
				fingerprint: 'AA:BB',
				auth: 'trusted'
			}
		]);
		expect(s.refusedPeers).toEqual([]);
		// The settings blob still clones: nothing reactive got in.
		expect(() => structuredClone(s)).not.toThrow();
		expect(invokeArgs(vi.mocked(invoke), 'peers_apply', -1)).toEqual({
			config: { enabled: true, peers: s.peers }
		});
	});

	it('records a refusal once', () => {
		refusePeer(DESK);
		refusePeer(DESK);
		expect(getSettings().refusedPeers).toEqual([DESK]);
	});

	it('refuses to trust this computer', async () => {
		route({ 'laptop.local': probe({ instanceId: OURS }) });
		await expect(checkPeer(['laptop.local'], 8788)).rejects.toThrow("That's this computer.");
	});

	it('uses the first address that answers', async () => {
		route({ '192.168.1.20': probe() });
		const result = await checkPeer(['10.0.0.5', '192.168.1.20'], 8788);
		expect(result).toEqual({ kind: 'new', probe: probe() });
		expect(invokeCalls(vi.mocked(invoke), 'peer_probe')).toHaveLength(2);
	});

	it('fails with the last error when no address answers', async () => {
		await expect(checkPeer(['10.0.0.5'], 8788)).rejects.toBe('offline');
	});

	it("updates a known computer's address instead of adding it again", async () => {
		await trustPeer(probe());
		route({ 'desk-pc': probe({ address: '192.168.1.44' }) });
		const result = await checkPeer(['desk-pc'], 8788);
		expect(result.kind).toBe('updated');
		expect(getSettings().peers).toHaveLength(1);
		expect(getSettings().peers[0].address).toBe('192.168.1.44');
	});

	it('asks again when a known computer shows another certificate', async () => {
		await trustPeer(probe());
		route({ 'desk-pc': probe({ fingerprint: 'CC:DD' }) });
		const result = await checkPeer(['desk-pc'], 8788);
		expect(result.kind).toBe('changed');
		// Nothing changes until the owner trusts the new one.
		expect(getSettings().peers[0].fingerprint).toBe('AA:BB');
		await trustPeer(probe({ fingerprint: 'CC:DD' }));
		expect(getSettings().peers.map((p) => p.fingerprint)).toEqual(['CC:DD']);
	});

	it('keeps a token in the secret store and drops it on removal', async () => {
		await trustPeer(probe());
		await setPeerToken(DESK, ' hsx_token ');
		expect(invokeArgs(vi.mocked(invoke), 'secret_set')).toEqual({
			key: `peer:${DESK}`,
			value: 'hsx_token'
		});
		expect(getSettings().peers[0].auth).toBe('token');
		expect(JSON.stringify(getSettings())).not.toContain('hsx_token');

		// Trusted again after a new certificate: still gets in with its token.
		await trustPeer(probe({ fingerprint: 'CC:DD' }));
		expect(getSettings().peers[0].auth).toBe('token');

		await removePeer(DESK);
		expect(getSettings().peers).toEqual([]);
		expect(invokeArgs(vi.mocked(invoke), 'secret_delete')).toEqual({ key: `peer:${DESK}` });
	});

	it('groups a fingerprint four bytes at a time', () => {
		expect(groupFingerprint('01:02:03:04:05:06')).toEqual(['01:02:03:04', '05:06']);
	});
});
