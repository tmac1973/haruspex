import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';

// What Rust reports: computers found on the network and each one's connection.
const rust = vi.hoisted(() => ({
	found: [] as unknown[],
	statuses: [] as unknown[],
	listeners: new Map<string, (e: { payload: unknown }) => void>()
}));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({
		instance_identity: { id: 'ours', name: 'laptop' },
		peers_found: () => rust.found,
		peers_status: () => rust.statuses,
		peer_probe: (args) => ({
			instanceId: 'study',
			name: 'study',
			version: '0.2.18',
			fingerprint: '01:02:03:04:05',
			address: (args as { address: string }).address,
			port: 8788
		})
	})
);
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
		rust.listeners.set(name, handler);
		return () => rust.listeners.delete(name);
	})
}));

import { invoke } from '@tauri-apps/api/core';
import { invokeArgs } from '#lib/testing/invoke.ts';
import { getSettings, updateSettings } from '#lib/stores/settings.ts';
import { resetPeersForTest } from '#lib/peers/service.ts';
import OtherComputers from './OtherComputers.svelte';

function peer(id: string, name: string) {
	return {
		instanceId: id,
		name,
		address: `${name}.local`,
		port: 8788,
		fingerprint: 'AA:BB',
		auth: 'trusted' as const
	};
}

function found(id: string, name: string) {
	return { instanceId: id, name, addresses: ['192.168.1.30'], port: 8788, version: '0.2.18' };
}

beforeEach(() => {
	resetPeersForTest();
	rust.found = [];
	rust.statuses = [];
	rust.listeners.clear();
	updateSettings({
		peersEnabled: true,
		peers: [peer('desk', 'desk-pc'), peer('mini', 'mac-mini'), peer('nas', 'nas')],
		refusedPeers: ['tv']
	});
});

describe('Settings → Remote control → Other computers', () => {
	it('offers only computers neither trusted nor refused', async () => {
		rust.found = [found('desk', 'desk-pc'), found('tv', 'living-room'), found('study', 'study')];
		render(OtherComputers);
		await screen.findByText('Found on your network');
		expect(screen.getAllByRole('button', { name: 'Connect…' })).toHaveLength(1);
		screen.getByText('study');
		expect(screen.queryByText('living-room')).toBeNull();
	});

	it("shows each computer's connection with what to do about it", async () => {
		rust.statuses = [
			{ peerId: 'desk', connection: 'open', lastSeen: 1 },
			{ peerId: 'mini', connection: 'notLetIn', lastSeen: null },
			{ peerId: 'nas', connection: 'certificateChanged', lastSeen: null }
		];
		render(OtherComputers);
		await screen.findByText('Connected');
		screen.getByText('Not letting this computer in');
		screen.getByRole('button', { name: 'Use a token…' });
		screen.getByText('Certificate changed');
		screen.getByRole('button', { name: 'Check again…' });

		// A later event moves it on.
		rust.listeners.get('peer://status')!({
			payload: { peerId: 'desk', connection: 'offline', lastSeen: 1 }
		});
		await screen.findByText('Offline');
	});

	it('trusts a found computer after its fingerprint is shown', async () => {
		rust.found = [found('study', 'study')];
		render(OtherComputers);
		await fireEvent.click(await screen.findByRole('button', { name: 'Connect…' }));
		await screen.findByText('Trust study?');
		screen.getByText('01:02:03:04');
		await fireEvent.click(screen.getByRole('button', { name: 'Trust' }));
		await waitFor(() => expect(getSettings().peers.map((p) => p.instanceId)).toContain('study'));
		expect(getSettings().peers.at(-1)?.address).toBe('192.168.1.30');
	});

	it("doesn't offer a computer again once it isn't trusted", async () => {
		rust.found = [found('study', 'study')];
		render(OtherComputers);
		await fireEvent.click(await screen.findByRole('button', { name: 'Connect…' }));
		await fireEvent.click(await screen.findByRole('button', { name: "Don't trust" }));
		await waitFor(() => expect(screen.queryByText('Found on your network')).toBeNull());
		expect(getSettings().refusedPeers).toContain('study');
	});

	it('saves a pasted token and switches the computer to it', async () => {
		rust.statuses = [{ peerId: 'mini', connection: 'notLetIn', lastSeen: null }];
		render(OtherComputers);
		await fireEvent.click(await screen.findByRole('button', { name: 'Use a token…' }));
		await fireEvent.input(screen.getByLabelText(/Paste a script token from mac-mini/), {
			target: { value: 'hsx_abc' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() =>
			expect(getSettings().peers.find((p) => p.instanceId === 'mini')?.auth).toBe('token')
		);
		expect(invokeArgs(vi.mocked(invoke), 'secret_set')).toEqual({
			key: 'peer:mini',
			value: 'hsx_abc'
		});
	});

	it('shows nothing found and no statuses while off', async () => {
		updateSettings({ peersEnabled: false });
		rust.found = [found('study', 'study')];
		rust.statuses = [{ peerId: 'desk', connection: 'open', lastSeen: 1 }];
		render(OtherComputers);
		await screen.findByText('desk-pc');
		expect(screen.queryByText('Found on your network')).toBeNull();
		expect(screen.queryByText('Connected')).toBeNull();
	});
});
