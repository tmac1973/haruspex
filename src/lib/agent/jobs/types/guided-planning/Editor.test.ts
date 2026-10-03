import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), imageKind: 'none' }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('$lib/stores/jobs.svelte', () => ({
	getJobs: () => [],
	getJob: vi.fn()
}));

vi.mock('$lib/image', () => ({ resolveImageBackend: () => ({ kind: mocks.imageKind }) }));

import Editor from './Editor.svelte';
import { emptyModelForm } from '../../jobModelForm';
import { guidedPlanningJobType } from './definition';

/**
 * Render coverage for the guided-planning editor. The pure config logic is
 * covered in config.test.ts, but none of the template executes in a type
 * check — and the coding-run section is shown only in one of three modes,
 * which is exactly the kind of condition a type check cannot see.
 */
function mount(over: Record<string, unknown> = {}) {
	const config = { ...guidedPlanningJobType.configDefaults!(), ...over };
	render(Editor, { props: { config, jobName: 'Test job' } });
	return config as Record<string, unknown>;
}

describe('guided-planning Editor', () => {
	it('mounts with the defaults', () => {
		mount();
		expect(screen.getByLabelText('Run mode')).toBeTruthy();
	});

	it('hides the coding-run section outside the chain mode', () => {
		for (const run_mode of ['attended', 'unattended_plan']) {
			const { unmount } = render(Editor, {
				props: {
					config: { ...guidedPlanningJobType.configDefaults!(), run_mode },
					jobName: 'Test job'
				}
			});
			expect(screen.queryByLabelText('Context mode')).toBeNull();
			unmount();
		}
	});

	it('shows it in the chain mode, where it is the only chance to set it', () => {
		mount({ run_mode: 'unattended_chain' });
		expect(screen.getByLabelText('Context mode')).toBeTruthy();
		expect(screen.getByLabelText('Max attempts per step')).toBeTruthy();
	});

	it('offers no verification command fields — preflight settles those', () => {
		mount({ run_mode: 'unattended_chain' });
		expect(screen.queryByLabelText('Phase verification command')).toBeNull();
		expect(screen.queryByLabelText('Step check command')).toBeNull();
	});

	it("defaults max attempts to the coding job's own default, not zero", () => {
		const cfg = mount({ run_mode: 'unattended_chain' });
		expect(cfg.coding_max_attempts).toBe(3);
	});

	it('disables skip-verification in the chain mode, and says why', () => {
		mount({ run_mode: 'unattended_chain' });
		const box = screen.getByRole('checkbox', { name: /Skip verification/ }) as HTMLInputElement;
		expect(box.disabled).toBe(true);
		expect(screen.getByText(/decides whether the coding run may start/)).toBeTruthy();
	});

	it('leaves skip-verification usable in the other modes', () => {
		mount({ run_mode: 'unattended_plan' });
		const box = screen.getByRole('checkbox', { name: /Skip verification/ }) as HTMLInputElement;
		expect(box.disabled).toBe(false);
	});

	describe('stage models', () => {
		it('offers a coding-run model only in the chain mode, defaulting to this job’s', () => {
			mount({ run_mode: 'unattended_plan' });
			expect(screen.queryByLabelText('Coding run model')).toBeNull();
			document.body.innerHTML = '';
			mount({ run_mode: 'unattended_chain' });
			const picker = screen.getByLabelText('Coding run model') as HTMLSelectElement;
			expect(picker.value).toBe('same');
			expect(screen.queryByText('Remote server')).toBeNull();
		});

		it('offers an asset-run model only when assets are generated', () => {
			mocks.imageKind = 'comfyui';
			try {
				mount({ run_mode: 'unattended_chain', generate_assets: false });
				expect(screen.queryByLabelText('Asset run model')).toBeNull();
				document.body.innerHTML = '';
				mount({ run_mode: 'unattended_chain', generate_assets: true });
				expect(screen.getByLabelText('Asset run model')).toBeTruthy();
			} finally {
				mocks.imageKind = 'none';
			}
		});

		it('shows the model fields for a chosen stage, without a "Settings model" source', () => {
			mount({ run_mode: 'unattended_chain', chain_coding_model: emptyModelForm('remote') });
			expect((screen.getByLabelText('Coding run model') as HTMLSelectElement).value).toBe('choose');
			expect(screen.getByText('Remote server')).toBeTruthy();
			// "Same as this job" already covers the Settings model.
			expect(screen.queryByText('Settings model (default)')).toBeNull();
		});
	});
});
