import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

const state = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
const setCodeHelperConfig = vi.hoisted(() =>
	vi.fn((id: string, value: unknown) => {
		state.config = { ...state.config, [id]: value };
	})
);
vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		overDefaults: true,
		settings: () => ({ codeHelperConfig: state.config }),
		setCodeHelperConfig
	})
);

import ThreeSettings from './ThreeSettings.svelte';

const remote = { baseUrl: 'http://gpu-box:8080', modelId: 'qwen-big', contextSize: 65536 };
const saved = () => setCodeHelperConfig.mock.calls.at(-1)![1] as Record<string, unknown>;

beforeEach(() => {
	state.config = {};
	setCodeHelperConfig.mockClear();
});

describe('ThreeSettings', () => {
	it('shows None, the default rounds and Unlimited when nothing is stored', () => {
		render(ThreeSettings, { helperId: '3d' });
		screen.getByRole('button', { name: 'Delegate to: None' });
		expect((screen.getByLabelText('Rounds per asset') as HTMLInputElement).value).toBe('80');
		expect((screen.getByLabelText('Unlimited') as HTMLInputElement).checked).toBe(true);
		expect((screen.getByLabelText('Cost limit per asset') as HTMLInputElement).disabled).toBe(true);
	});

	it('saves a picked model, then None clears it', async () => {
		state.config = { '3d': { backend: remote } };
		render(ThreeSettings, { helperId: '3d' });
		await fireEvent.click(
			screen.getByRole('button', { name: 'Delegate to: qwen-big · gpu-box:8080' })
		);
		// The Settings model would follow the global model, not name a delegate.
		expect(screen.queryByRole('radio', { name: /Settings model/ })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(saved()).toEqual({ backend: remote, maxRounds: 80, maxCostUsd: null });
		expect(() => structuredClone(saved())).not.toThrow();

		await fireEvent.click(screen.getByRole('button', { name: /Delegate to:/ }));
		await fireEvent.click(screen.getByRole('button', { name: 'None' }));
		expect(saved().backend).toBeNull();
		screen.getByRole('button', { name: 'Delegate to: None' });
	});

	it('clamps the round field', async () => {
		render(ThreeSettings, { helperId: '3d' });
		const rounds = screen.getByLabelText('Rounds per asset') as HTMLInputElement;
		await fireEvent.input(rounds, { target: { value: '2' } });
		await fireEvent.change(rounds);
		expect(saved().maxRounds).toBe(5);
		await fireEvent.input(rounds, { target: { value: '9000' } });
		await fireEvent.change(rounds);
		expect(saved().maxRounds).toBe(500);
		expect(rounds.value).toBe('500');
	});

	it('saves a dollar cap, and null with Unlimited', async () => {
		render(ThreeSettings, { helperId: '3d' });
		await fireEvent.click(screen.getByLabelText('Unlimited'));
		const cost = screen.getByLabelText('Cost limit per asset') as HTMLInputElement;
		expect(cost.disabled).toBe(false);
		await fireEvent.input(cost, { target: { value: '2.5' } });
		await fireEvent.change(cost);
		expect(saved().maxCostUsd).toBe(2.5);
		await fireEvent.click(screen.getByLabelText('Unlimited'));
		expect(saved().maxCostUsd).toBeNull();
		expect(() => structuredClone(saved())).not.toThrow();
	});
});
