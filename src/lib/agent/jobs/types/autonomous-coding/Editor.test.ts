import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('$lib/stores/jobs.svelte', () => ({
	getJobs: () => [],
	getJob: vi.fn()
}));

import Editor from './Editor.svelte';
import { autonomousCodingJobType } from './definition';

/**
 * A render smoke test. The pure logic behind this editor is covered in
 * commandSuggestions.test.ts, config.test.ts and Tooltip.test.ts — but the
 * template itself was rewritten wholesale (labels to divs, a `{@render}`
 * snippet shared by both command fields, tooltips in place of hints), and
 * none of that executes in a type check. A component that throws on mount
 * would otherwise reach the user.
 */
/**
 * Returns the config object as well as the render result. Assertions about
 * what the editor *writes* go against this object rather than the input's DOM
 * value: `config` is only deeply reactive when the parent passes a `$state`
 * proxy, which JobEditor does (`typeConfig = $state(...)`) and a plain object
 * in a test does not. The editor's job is to put the right value in the
 * config; reflecting it back into the input is Svelte's.
 */
function mount(overrides: Record<string, unknown> = {}, workingDir = '/repo') {
	const config = { ...autonomousCodingJobType.configDefaults(), ...overrides };
	return { config, ...render(Editor, { config, workingDir }) };
}

beforeEach(() => {
	mocks.invoke.mockReset().mockRejectedValue(new Error('no fs in tests'));
	mocks.open.mockReset();
});

describe('autonomous-coding Editor', () => {
	it('renders every field without throwing', () => {
		mount();
		expect(screen.getByLabelText('Plan directory')).toBeTruthy();
		expect(screen.getByLabelText('Context mode')).toBeTruthy();
		expect(screen.getByLabelText('Signing fallback')).toBeTruthy();
		expect(screen.getByLabelText('Max attempts per step')).toBeTruthy();
	});

	it('offers web research in preflight, on by default', () => {
		mount();
		const box = screen.getByLabelText('Web research during preflight') as HTMLInputElement;
		expect(box.checked).toBe(true);
	});

	it('exposes help through tooltips rather than paragraphs', async () => {
		mount();
		const tips = screen.getAllByRole('button', { name: /^About / });
		expect(tips.length).toBeGreaterThan(3);
		await fireEvent.focus(tips[0]);
		expect(screen.getByRole('tooltip')).toBeTruthy();
	});

	it('rejects a plan dir picked outside the working dir', async () => {
		mocks.open.mockResolvedValueOnce('/somewhere/else/plan');
		mount();
		await fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
		expect(await screen.findByText(/inside the working directory/)).toBeTruthy();
	});

	it('stores a picked plan dir as a relative path', async () => {
		mocks.open.mockResolvedValueOnce('/repo/plan/my-feature');
		const { config } = mount();
		await fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
		await vi.waitFor(() => expect(config.plan_dir).toBe('plan/my-feature/'));
		// Rooted at the working dir so the user starts where the plans live.
		expect(mocks.open.mock.calls[0][0]).toMatchObject({ directory: true, defaultPath: '/repo' });
	});

	it('explains itself when no working dir is set yet', async () => {
		mount({}, '');
		await fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
		expect(await screen.findByText(/working directory first/)).toBeTruthy();
		expect(mocks.open).not.toHaveBeenCalled();
	});
});

describe('autonomous-coding Editor — no command fields', () => {
	/**
	 * The verification commands used to be two text boxes with a suggestion
	 * picker behind them. They are gone: preflight can see the repo and run a
	 * candidate to check it works, which is more than a user can do before the
	 * project exists. A preference goes in the plan or the build prompt, where
	 * it is context the model reasons about rather than a field it obeys.
	 */
	it('offers neither command field, in either context mode', () => {
		for (const context_mode of ['phase', 'step']) {
			const { unmount } = render(Editor, {
				props: {
					config: { ...autonomousCodingJobType.configDefaults!(), context_mode },
					workingDir: '/repo'
				}
			});
			expect(screen.queryByLabelText('Phase verification command')).toBeNull();
			expect(screen.queryByLabelText('Step check command')).toBeNull();
			unmount();
		}
	});
});
