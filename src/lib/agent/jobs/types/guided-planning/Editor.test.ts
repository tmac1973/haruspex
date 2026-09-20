import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('$lib/stores/jobs.svelte', () => ({
	getJobs: () => [],
	getJob: vi.fn()
}));

import Editor from './Editor.svelte';
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
});
