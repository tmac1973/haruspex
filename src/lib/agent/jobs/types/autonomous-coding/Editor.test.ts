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
		expect(screen.getByLabelText('Phase verification command')).toBeTruthy();
		expect(screen.getByLabelText('Context mode')).toBeTruthy();
		expect(screen.getByLabelText('Signing fallback')).toBeTruthy();
		expect(screen.getByLabelText('Max attempts per step')).toBeTruthy();
	});

	it('renders the shared command snippet for both fields', () => {
		// The step-check field only exists in per-step mode, and both fields
		// come from one `{@render}` snippet — a snippet resolution problem
		// would surface as a missing field or a mount error.
		mount({ context_mode: 'step' });
		expect(screen.getByLabelText('Step check command')).toBeTruthy();
		expect(screen.getByLabelText('Phase verification command')).toBeTruthy();
	});

	it('hides the step check in per-phase mode', () => {
		mount({ context_mode: 'phase' });
		expect(screen.queryByLabelText('Step check command')).toBeNull();
	});

	it('offers catalog suggestions even with no readable project', () => {
		// invoke rejects here, so both detection tiers come back empty. The
		// dropdown must still be useful rather than absent.
		mount();
		const picker = screen.getByLabelText('Phase verification command suggestions');
		expect(picker).toBeTruthy();
		const values = Array.from(picker.querySelectorAll('option'))
			.map((o) => (o as HTMLOptionElement).value)
			.filter(Boolean);
		expect(values).toContain('npm test');
		expect(values).toContain('cargo test');
	});

	it('writes a picked suggestion into the config and resets the picker', async () => {
		// The text box stays authoritative; the picker is an input method, not
		// the value's home.
		const { config } = mount();
		const picker = screen.getByLabelText(
			'Phase verification command suggestions'
		) as HTMLSelectElement;
		await fireEvent.change(picker, { target: { value: 'cargo test' } });

		expect(config.verify_command).toBe('cargo test');
		// Reset so the same suggestion can be chosen again after an edit.
		expect(picker.value).toBe('');
	});

	it('keeps the deliberate inline guidance visible', () => {
		// "Leave it blank" is a decision, not a description — hiding it behind
		// a hover would break the preflight path for anyone who never hovers.
		mount();
		expect(screen.getByText(/Not sure\? Leave it blank\./)).toBeTruthy();
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
