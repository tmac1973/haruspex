import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { invokeRouter } from '#lib/testing/invoke.ts';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import ApiKeysSection from './ApiKeysSection.svelte';

function storeKind(kind: string) {
	tauri.invoke.mockImplementation(invokeRouter({ secret_store_kind: kind }, true));
}

describe('ApiKeysSection', () => {
	beforeEach(() => storeKind('keychain'));

	it('warns when a pasted key has a space in it', async () => {
		render(ApiKeysSection);
		const value = screen.getAllByPlaceholderText('Key value').at(-1) as HTMLInputElement;
		expect(screen.queryByRole('alert')).toBeNull();
		await fireEvent.input(value, { target: { value: 'coding - sk-or-v1-abc' } });
		expect(screen.getByRole('alert').textContent).toMatch(/Paste only the key/);
		await fireEvent.input(value, { target: { value: 'sk-or-v1-abc' } });
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('says nothing about the store when the keychain works', async () => {
		render(ApiKeysSection);
		await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith('secret_store_kind'));
		expect(screen.queryByText(/encrypted file/)).toBeNull();
	});

	it('says so when keys go to the encrypted file', async () => {
		storeKind('file');
		render(ApiKeysSection);
		const note = await screen.findByText(/kept in Haruspex's encrypted file/);
		expect(note.getAttribute('title')).toMatch(/anything that can read your files/);
	});

	it('says so when keys last only until Haruspex closes', async () => {
		storeKind('none');
		render(ApiKeysSection);
		expect(await screen.findByText(/only until Haruspex closes/)).toBeTruthy();
	});
});
