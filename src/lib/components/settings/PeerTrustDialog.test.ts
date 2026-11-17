import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import PeerTrustDialog from './PeerTrustDialog.svelte';

const probe = {
	instanceId: 'desk',
	name: 'desk-pc',
	version: '0.2.18',
	fingerprint: '11:22:33:44:55:66:77:88',
	address: '192.168.1.20',
	port: 8788
};

function renderDialog(pinned: string | null) {
	const handlers = { ontrust: vi.fn(), onrefuse: vi.fn(), oncancel: vi.fn() };
	render(PeerTrustDialog, { probe, pinned, ...handlers });
	return handlers;
}

describe('PeerTrustDialog', () => {
	it('shows a first contact its fingerprint and where to check it', async () => {
		const { ontrust } = renderDialog(null);
		screen.getByText('Trust desk-pc?');
		screen.getByText(/Advanced → Certificate on desk-pc/);
		screen.getByText('11:22:33:44');
		screen.getByText('55:66:77:88');
		expect(screen.queryByText('Trusted before')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Trust' }));
		expect(ontrust).toHaveBeenCalledOnce();
	});

	it('shows both fingerprints when the certificate changed', async () => {
		const { onrefuse } = renderDialog('AA:BB:CC:DD');
		screen.getByText("desk-pc's certificate changed");
		expect(screen.getByLabelText('Trusted before').textContent).toContain('AA:BB:CC:DD');
		expect(screen.getByLabelText('Now').textContent).toContain('11:22:33:44');
		await fireEvent.click(screen.getByRole('button', { name: "Don't trust" }));
		expect(onrefuse).toHaveBeenCalledOnce();
	});
});
