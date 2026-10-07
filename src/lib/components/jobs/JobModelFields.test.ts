import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import JobModelFields from '#lib/components/jobs/JobModelFields.svelte';
import { emptyModelForm } from '#lib/agent/jobs/jobModelForm.ts';
import type { OpenRouterModel } from '#lib/openrouter.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));

function model(id: string, name: string): OpenRouterModel {
	return {
		id,
		name,
		context_length: 128000,
		architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
		supported_parameters: ['tools'],
		pricing: { prompt: '0.000001', completion: '0.000002', request: '0' }
	} as OpenRouterModel;
}

vi.mock('#lib/openrouter.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/openrouter.ts')>()),
	fetchOpenRouterCatalog: vi.fn(async () => [
		model('a/one', 'Model One'),
		model('b/two', 'Model Two')
	])
}));

describe('JobModelFields OpenRouter picker', () => {
	it('closes the model list after a pick', async () => {
		const form = emptyModelForm('openrouter');
		render(JobModelFields, { form, name: 'src' });

		await fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
		const trigger = await screen.findByRole('button', { expanded: false });
		await fireEvent.click(trigger);
		expect(screen.getByPlaceholderText('Search models…')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: /Model Two/ }));
		expect(screen.queryByPlaceholderText('Search models…')).toBeNull();
		expect(form.modelId).toBe('b/two');
	});
});
