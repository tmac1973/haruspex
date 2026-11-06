import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('./pipeline', () => ({ runModelGenerationPipeline: vi.fn() }));

import Editor from './Editor.svelte';
import { emptyModelForm } from '../../jobModelForm';
import { modelGenerationJobType } from './definition';

function mount(over: Record<string, unknown> = {}, jobModel = emptyModelForm()) {
	const config = { ...modelGenerationJobType.configDefaults(), ...over };
	render(Editor, { props: { config, jobModel } });
	return config;
}

const blind = (vision: 'yes' | 'no') => ({ ...emptyModelForm('remote'), vision });

describe('3D models Editor', () => {
	it('shows both model rows, each the job’s model by default', () => {
		mount();
		screen.getByLabelText('Change the creation model');
		screen.getByLabelText('Change the animation model');
		expect(screen.getAllByText('Same as this job')).toHaveLength(2);
	});

	it('warns on each row whose model cannot see', () => {
		mount({ chain_create_model: blind('yes') }, blind('no'));
		// The animation row inherits the blind job model; creation has its own.
		expect(screen.getAllByText('No vision: it works from the text report only.')).toHaveLength(1);
	});

	it('warns on neither when both models see', () => {
		mount({}, blind('yes'));
		expect(screen.queryByText(/No vision/)).toBeNull();
	});

	it('opens a stage’s model fields in a dialog', async () => {
		mount();
		await fireEvent.click(screen.getByLabelText('Change the animation model'));
		expect((screen.getByLabelText('Animation model') as HTMLSelectElement).value).toBe('same');
	});

	it('leaves textures off by default', () => {
		mount();
		expect((screen.getByLabelText(/Allow textures/) as HTMLInputElement).checked).toBe(false);
	});
});

describe('3D models Editor — chain', () => {
	it('shows the coding handoff only for a job a chain made', () => {
		mount();
		expect(screen.queryByText('Start the coding run when done')).toBeNull();
	});

	it('shows it, on, for a chained job', () => {
		mount({ coding_run: { plan_dir: 'plan/x/' } });
		expect((screen.getByLabelText(/Start the coding run/) as HTMLInputElement).checked).toBe(true);
	});
});
