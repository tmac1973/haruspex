import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';

// The device list as Rust would hold it.
const backend = vi.hoisted(() => {
	let devices: { id: string; name: string; scopes: string[]; createdAt: number; lastSeen: null }[] =
		[];
	return {
		reset() {
			devices = [];
		},
		handle(cmd: string, args: Record<string, unknown> = {}): unknown {
			switch (cmd) {
				case 'owner_api_status':
				case 'owner_api_apply':
					return { running: true, port: 8788, bindAll: false, address: '127.0.0.1' };
				case 'remote_link_qr':
					return { size: 1, modules: [true] };
				case 'owner_client_pair': {
					const client = devices.find((d) => d.id === args.id)!;
					return { client, token: 'hsx_new', pairCode: 'def456' };
				}
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
	it('shows a new device token once, then only the device', async () => {
		render(OwnerApiSection);
		expect(await screen.findByText('No devices yet.')).toBeTruthy();

		await fireEvent.input(screen.getByLabelText('Device name'), { target: { value: 'Laptop' } });
		await fireEvent.click(screen.getByLabelText('Approve'));
		await fireEvent.click(screen.getByRole('button', { name: 'Add device' }));

		expect(await screen.findByText('hsx_secret')).toBeTruthy();
		expect(screen.getByText(/won't see it again/)).toBeTruthy();
		expect(screen.getByText('http://127.0.0.1:8788/app/#pair=abc123')).toBeTruthy();
		expect(await screen.findByRole('img', { name: /QR code/ })).toBeTruthy();
		expect(screen.getByText(/Read, Drive/)).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
		expect(screen.queryByText('hsx_secret')).toBeNull();
		expect(screen.getByText('Laptop')).toBeTruthy();
	});

	it('gives a device a new pairing link', async () => {
		backend.handle('owner_client_create', { name: 'Phone', scopes: ['read'] });
		render(OwnerApiSection);
		await fireEvent.click(await screen.findByRole('button', { name: 'New link' }));
		expect(await screen.findByText('http://127.0.0.1:8788/app/#pair=def456')).toBeTruthy();
		expect(screen.getByText('hsx_new')).toBeTruthy();
	});

	it('revokes a device', async () => {
		backend.handle('owner_client_create', { name: 'Phone', scopes: ['read'] });
		render(OwnerApiSection);
		await fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
		await waitFor(() => expect(screen.queryByText('Phone')).toBeNull());
		expect(screen.getByText('No devices yet.')).toBeTruthy();
	});

	it('needs a name and a permission to add a device', async () => {
		render(OwnerApiSection);
		const add = screen.getByRole('button', { name: 'Add device' }) as HTMLButtonElement;
		expect(add.disabled).toBe(true);
		await fireEvent.input(screen.getByLabelText('Device name'), { target: { value: 'Tablet' } });
		expect(add.disabled).toBe(false);
		for (const label of ['Read', 'Drive', 'Approve']) {
			await fireEvent.click(screen.getByLabelText(label));
		}
		expect(add.disabled).toBe(true);
	});
});
