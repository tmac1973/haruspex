import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import SkillApprovalModal from './SkillApprovalModal.svelte';
import { askSkillApproval } from '#lib/stores/skillApproval.svelte.ts';

// A stand-in editor: a textarea, so a test can type into it. The real one is
// covered by codemirror.test.ts.
vi.mock('#lib/editor/codemirror.ts', () => ({
	createEditor(host: HTMLElement, opts: { doc: string; onChange?: (v: string) => void }) {
		const area = document.createElement('textarea');
		area.value = opts.doc;
		area.setAttribute('aria-label', 'editor text');
		area.addEventListener('input', () => opts.onChange?.(area.value));
		host.append(area);
		return {
			getValue: () => area.value,
			setValue: (v: string) => (area.value = v),
			focus: () => {},
			destroy: () => area.remove()
		};
	}
}));

const TEXT = '---\nname: deploy-check\n---\n\nRun the checks.\n';

function ask(over: Partial<Parameters<typeof askSkillApproval>[0]> = {}) {
	const save = vi.fn().mockResolvedValue(undefined);
	const done = askSkillApproval({
		update: false,
		name: 'deploy-check',
		dir: '/data/skills/deploy-check',
		project: false,
		text: TEXT,
		current: null,
		save,
		...over
	});
	return { save, done };
}

async function type(text: string) {
	const area = (await screen.findByLabelText('editor text')) as HTMLTextAreaElement;
	area.value = text;
	await fireEvent.input(area);
}

describe('SkillApprovalModal', () => {
	it('saves the edited text and says it was edited', async () => {
		render(SkillApprovalModal);
		const { save, done } = ask();
		expect(await screen.findByText('/data/skills/deploy-check')).toBeTruthy();
		await type(TEXT.replace('checks', 'checks twice'));
		await fireEvent.click(screen.getByText('Save skill'));
		expect(await done).toEqual({ kind: 'saved', edited: true });
		expect(save).toHaveBeenCalledWith(TEXT.replace('checks', 'checks twice'));
	});

	it('stays open with the error when the text cannot be saved', async () => {
		render(SkillApprovalModal);
		const { save, done } = ask();
		save.mockRejectedValueOnce('the name must stay "deploy-check"');
		await screen.findByLabelText('editor text');
		await fireEvent.click(screen.getByText('Save skill'));
		expect(await screen.findByRole('alert')).toHaveProperty(
			'textContent',
			'Not saved: the name must stay "deploy-check"'
		);
		await fireEvent.click(screen.getByText('Save skill'));
		expect(await done).toEqual({ kind: 'saved', edited: false });
	});

	it('rejects with the reason typed', async () => {
		render(SkillApprovalModal);
		const { save, done } = ask();
		const reason = await screen.findByPlaceholderText('Sent to the model');
		await fireEvent.input(reason, { target: { value: 'too vague' } });
		await fireEvent.click(screen.getByText('Reject'));
		expect(await done).toEqual({ kind: 'rejected', reason: 'too vague' });
		expect(save).not.toHaveBeenCalled();
		await waitFor(() => expect(screen.queryByText('Reject')).toBeNull());
	});

	it('shows the current version of a skill being changed', async () => {
		render(SkillApprovalModal);
		const { done } = ask({ update: true, current: 'OLD SKILL TEXT' });
		await fireEvent.click(await screen.findByText('Show the current version'));
		expect(screen.getByText('OLD SKILL TEXT')).toBeTruthy();
		await fireEvent.click(screen.getByText('Reject'));
		await done;
	});
});
