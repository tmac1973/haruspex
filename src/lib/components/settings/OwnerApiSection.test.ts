import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';

// The devices, trusted computers and server as Rust would hold them.
const backend = vi.hoisted(() => {
	let devices: { id: string; name: string; scopes: string[]; createdAt: number; lastSeen: null }[] =
		[];
	let lastConfig: Record<string, unknown> | null = null;
	return {
		reset() {
			devices = [];
			lastConfig = null;
		},
		get lastConfig() {
			return lastConfig;
		},
		handle(cmd: string, args: Record<string, unknown> = {}): unknown {
			switch (cmd) {
				case 'owner_api_apply':
					lastConfig = args.config as Record<string, unknown>;
					return {
						running: true,
						port: 8788,
						bindAll: true,
						address: '192.168.1.174',
						hostname: 'asmodean'
					};
				case 'owner_api_status':
					return {
						running: true,
						port: 8788,
						bindAll: true,
						address: '192.168.1.174',
						hostname: 'asmodean'
					};
				case 'owner_trusted_hosts': {
					const access = (lastConfig?.access ?? { trustedHosts: [] }) as {
						trustedHosts: string[];
					};
					return access.trustedHosts.map((name) => ({
						name,
						addresses: name === 'ghost' ? [] : ['192.168.1.20']
					}));
				}
				case 'remote_link_qr':
					return { size: 1, modules: [true] };
				case 'owner_clients_list':
					return devices;
				case 'owner_client_create': {
					const client = {
						id: `d${devices.length + 1}`,
						name: args.name as string,
						scopes: args.scopes as string[],
						createdAt: 1,
						lastSeen: null
					};
					devices = [...devices, client];
					return { client, token: 'hsx_secret', pairCode: 'abc123' };
				}
				case 'owner_client_pair': {
					const client = devices.find((d) => d.id === args.id)!;
					return { client, token: 'hsx_new', pairCode: 'def456' };
				}
				case 'owner_client_revoke':
					devices = devices.filter((d) => d.id !== args.id);
					return true;
				default:
					return null;
			}
		}
	};
});

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => backend.handle(cmd, args))
}));

import OwnerApiSection from './OwnerApiSection.svelte';

beforeEach(() => backend.reset());

describe('Settings → Remote control', () => {
	it('adds a device and leads with its one-time link', async () => {
		render(OwnerApiSection);
		await fireEvent.click(await screen.findByRole('button', { name: 'Add a device…' }));
		await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Laptop' } });
		await fireEvent.click(screen.getByLabelText('Approve'));
		await fireEvent.click(screen.getByRole('button', { name: 'Create link' }));

		expect(await screen.findByText('Open this link on Laptop')).toBeTruthy();
		expect(screen.getByText('http://192.168.1.174:8788/app/#pair=abc123')).toBeTruthy();
		expect(await screen.findByRole('img', { name: /QR code/ })).toBeTruthy();
		// The token is there for scripts, behind the link.
		expect(screen.getByText('Token for a script')).toBeTruthy();
		expect(screen.getByText(/Read, Drive/)).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
		expect(screen.queryByText('hsx_secret')).toBeNull();
		expect(screen.getByText('Laptop')).toBeTruthy();
	});

	it('needs a name and a permission to make a link', async () => {
		render(OwnerApiSection);
		await fireEvent.click(await screen.findByRole('button', { name: 'Add a device…' }));
		const create = screen.getByRole('button', { name: 'Create link' }) as HTMLButtonElement;
		expect(create.disabled).toBe(true);
		await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Tablet' } });
		expect(create.disabled).toBe(false);
		for (const label of ['Read', 'Drive', 'Approve']) {
			await fireEvent.click(screen.getByLabelText(label));
		}
		expect(create.disabled).toBe(true);
	});

	it('gives a device a new link, and revokes one', async () => {
		backend.handle('owner_client_create', { name: 'Phone', scopes: ['read'] });
		render(OwnerApiSection);
		await fireEvent.click(await screen.findByRole('button', { name: 'New link' }));
		expect(await screen.findByText('http://192.168.1.174:8788/app/#pair=def456')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
		await waitFor(() => expect(screen.queryByText('Phone')).toBeNull());
	});

	it('trusts listed computers without a token, and says where each was found', async () => {
		render(OwnerApiSection);
		await fireEvent.click(await screen.findByRole('button', { name: 'These computers' }));
		const input = screen.getByLabelText('Computer name or IP address');
		await fireEvent.input(input, { target: { value: 'laptop' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
		await fireEvent.input(input, { target: { value: 'ghost' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add' }));

		await waitFor(() => expect(screen.getByText('192.168.1.20')).toBeTruthy());
		expect(screen.getByText('not found')).toBeTruthy();
		expect(backend.lastConfig).toMatchObject({
			bindAll: true,
			access: { mode: 'trusted', trustedHosts: ['laptop', 'ghost'] }
		});
		// No token needed: the page's address is what to open.
		expect(screen.getByText('http://192.168.1.174:8788/app/')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Remove ghost' }));
		await waitFor(() =>
			expect(backend.lastConfig).toMatchObject({ access: { trustedHosts: ['laptop'] } })
		);
	});

	it('lets the whole network in when asked', async () => {
		render(OwnerApiSection);
		await fireEvent.click(await screen.findByRole('button', { name: 'My whole network' }));
		await waitFor(() =>
			expect(backend.lastConfig).toMatchObject({ bindAll: true, access: { mode: 'lan' } })
		);
		expect(screen.queryByLabelText('Computer name or IP address')).toBeNull();
	});
});
