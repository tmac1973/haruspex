import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => true) }));

import ApiKeysSection from './ApiKeysSection.svelte';

describe('ApiKeysSection', () => {
	it('warns when a pasted key has a space in it', async () => {
		render(ApiKeysSection);
		const value = screen.getAllByPlaceholderText('Key value').at(-1) as HTMLInputElement;
		expect(screen.queryByRole('alert')).toBeNull();
		await fireEvent.input(value, { target: { value: 'coding - sk-or-v1-abc' } });
		expect(screen.getByRole('alert').textContent).toMatch(/Paste only the key/);
		await fireEvent.input(value, { target: { value: 'sk-or-v1-abc' } });
		expect(screen.queryByRole('alert')).toBeNull();
	});
});
