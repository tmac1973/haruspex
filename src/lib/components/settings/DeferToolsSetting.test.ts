import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

const settings = vi.hoisted(() => ({ deferTools: 'auto' as string, leanMode: false }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getLiveSettings: () => settings,
	updateSettings: vi.fn((patch: object) => Object.assign(settings, patch))
}));

import { updateSettings } from '#lib/stores/settings.ts';
import DeferToolsSetting from './DeferToolsSetting.svelte';

beforeEach(() => {
	Object.assign(settings, { deferTools: 'auto', leanMode: false });
	vi.mocked(updateSettings).mockClear();
});

describe('Settings → General → Load tools when needed', () => {
	it('shows Auto as the choice by default', () => {
		render(DeferToolsSetting);
		expect(screen.getByRole('button', { name: 'Auto' }).classList).toContain('active');
		expect(screen.getByRole('button', { name: 'On' }).classList).not.toContain('active');
	});

	it('saves the choice', async () => {
		render(DeferToolsSetting);
		await fireEvent.click(screen.getByRole('button', { name: 'Off' }));
		expect(updateSettings).toHaveBeenCalledWith({ deferTools: 'off' });
	});

	it('cannot be changed in lean mode', () => {
		settings.leanMode = true;
		render(DeferToolsSetting);
		for (const name of ['Auto', 'On', 'Off']) {
			expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
		}
	});
});
