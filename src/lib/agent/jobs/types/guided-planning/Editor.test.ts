import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), imageKind: 'none' }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('#lib/stores/jobs.svelte.ts', () => ({
	getJobs: () => [],
	getJob: vi.fn()
}));

vi.mock('#lib/image/index.ts', () => ({ resolveImageBackend: () => ({ kind: mocks.imageKind }) }));

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
			expect(screen.queryByLabelText('Max model steps per turn')).toBeNull();
			unmount();
		}
	});

	it('shows it in the chain mode, where it is the only chance to set it', () => {
		mount({ run_mode: 'unattended_chain' });
		expect(screen.getByLabelText('Max model steps per turn')).toBeTruthy();
		expect(screen.queryByLabelText('Max attempts per step')).toBeNull();
	});

	it('offers no verification command fields — preflight settles those', () => {
		mount({ run_mode: 'unattended_chain' });
		expect(screen.queryByLabelText('Phase verification command')).toBeNull();
		expect(screen.queryByLabelText('Step check command')).toBeNull();
	});

	it('offers no skip in the chain mode, and says why', () => {
		mount({ run_mode: 'unattended_chain' });
		const select = screen.getByLabelText('Verification') as HTMLSelectElement;
		const skip = [...select.options].find((o) => o.value === 'skip')!;
		expect(skip.disabled).toBe(true);
		expect(screen.getByText(/decides whether the coding run may start/)).toBeTruthy();
	});

	it('offers full, lite and skip in the other modes', () => {
		mount({ run_mode: 'unattended_plan' });
		const select = screen.getByLabelText('Verification') as HTMLSelectElement;
		expect([...select.options].map((o) => [o.value, o.disabled])).toEqual([
			['full', false],
			['lite', false],
			['skip', false]
		]);
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

		it('shows the model fields for a chosen stage, with the Settings model as a choice', () => {
			mount({ run_mode: 'unattended_chain', chain_coding_model: emptyModelForm('remote') });
			expect((screen.getByLabelText('Coding run model') as HTMLSelectElement).value).toBe('choose');
			expect(screen.getByText('Remote server')).toBeTruthy();
			// The local model while planning runs remotely: not the same as
			// "Same as this job", and not marked "(default)" here.
			expect(screen.getByText('Settings model')).toBeTruthy();
			expect(screen.queryByText('Settings model (default)')).toBeNull();
		});
	});

	describe('planning skill', () => {
		const summary = (name: string, forGuidedPlanning: boolean) => ({
			name,
			description: `${name} does things`,
			source: 'user',
			dir: `/s/${name}`,
			license: null,
			compatibility: null,
			allowedTools: null,
			warnings: [],
			error: null,
			shadowed: false,
			createdByModel: false,
			codeModeOnly: false,
			forGuidedPlanning
		});

		it('lists planning skills first, then the rest', async () => {
			mocks.invoke.mockImplementation(async (cmd: string) =>
				cmd === 'skills_list' ? [summary('deploy', false), summary('plan-web-app', true)] : null
			);
			mount();
			const select = screen.getByLabelText('Planning skill') as HTMLSelectElement;
			await vi.waitFor(() => expect(select.options.length).toBe(3));
			expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual([
				'For planning',
				'Other skills'
			]);
			expect([...select.options].map((o) => o.value)).toEqual(['', 'plan-web-app', 'deploy']);
		});

		it('says when the chosen skill is gone', async () => {
			mocks.invoke.mockImplementation(async (cmd: string) =>
				cmd === 'skills_list' ? [summary('plan-web-app', true)] : null
			);
			mount({ planning_skill: 'plan-old' });
			expect(await screen.findByText(/Not in your skills any more/)).toBeTruthy();
			expect(screen.getByText('plan-old (missing)')).toBeTruthy();
		});
	});
});
