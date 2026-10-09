import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { invoke } from '@tauri-apps/api/core';
import FileEditorModal from './FileEditorModal.svelte';
import { editWorkdirFiles, getPendingEdit } from '#lib/stores/fileEditor.svelte.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

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

const files: Record<string, string> = {
	'plan/x/phase-01-setup.md': '# Phase 01\n',
	'plan/x/phase-02-api.md': '# Phase 02\n'
};

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
		const a = args as { relPath: string };
		if (cmd === 'fs_read_text_full') return Promise.resolve(files[a.relPath]);
		return Promise.resolve(undefined);
	});
});

async function type(text: string) {
	const area = (await screen.findByLabelText('editor text')) as HTMLTextAreaElement;
	area.value = text;
	await fireEvent.input(area);
}

describe('FileEditorModal', () => {
	it('opens the files, saves an edit to disk and reports it', async () => {
		render(FileEditorModal);
		const done = editWorkdirFiles({
			workdir: '/proj',
			files: Object.keys(files),
			title: 'Implementation plan'
		});
		expect(await screen.findByText('phase-02-api.md')).toBeTruthy();

		await type('# Phase 01, revised\n');
		await fireEvent.click(screen.getByText('Save'));
		expect(invoke).toHaveBeenCalledWith('fs_write_text', {
			workdir: '/proj',
			relPath: 'plan/x/phase-01-setup.md',
			content: '# Phase 01, revised\n',
			overwrite: true
		});

		await fireEvent.click(screen.getByText('Done'));
		await expect(done).resolves.toEqual({ saved: ['plan/x/phase-01-setup.md'] });
	});

	it('asks before closing over unsaved changes, and can save them', async () => {
		render(FileEditorModal);
		const done = editWorkdirFiles({
			workdir: '/proj',
			files: ['plan/x/phase-01-setup.md'],
			title: 'Plan'
		});
		await type('changed\n');
		await fireEvent.click(screen.getByText('Done'));
		expect(screen.getByText('Unsaved changes.')).toBeTruthy();
		expect(invoke).not.toHaveBeenCalledWith('fs_write_text', expect.anything());

		await fireEvent.click(screen.getByText('Save and close'));
		await expect(done).resolves.toEqual({ saved: ['plan/x/phase-01-setup.md'] });
		expect(invoke).toHaveBeenCalledWith(
			'fs_write_text',
			expect.objectContaining({ content: 'changed\n' })
		);
	});

	it('discards unsaved changes when told to', async () => {
		render(FileEditorModal);
		const done = editWorkdirFiles({
			workdir: '/proj',
			files: ['plan/x/phase-01-setup.md'],
			title: 'Plan'
		});
		await type('changed\n');
		await fireEvent.click(screen.getByText('Done'));
		await fireEvent.click(screen.getByText('Discard'));
		await expect(done).resolves.toEqual({ saved: [] });
		expect(invoke).not.toHaveBeenCalledWith('fs_write_text', expect.anything());
	});

	it('shows a save failure and stays open', async () => {
		vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
			if (cmd === 'fs_read_text_full')
				return Promise.resolve(files[(args as { relPath: string }).relPath]);
			if (cmd === 'fs_write_text') return Promise.reject('disk full');
			return Promise.resolve(undefined);
		});
		render(FileEditorModal);
		void editWorkdirFiles({ workdir: '/proj', files: ['plan/x/phase-01-setup.md'], title: 'P' });
		await type('changed\n');
		await fireEvent.click(screen.getByText('Save'));
		await waitFor(() =>
			expect(screen.getByText(/Could not save plan\/x\/phase-01-setup.md: disk full/)).toBeTruthy()
		);
		expect(screen.getByText('Done')).toBeTruthy();
	});

	it('stays a plain modal for the Jobs checkpoint: no watching, no conflict check', async () => {
		getPendingEdit()?.finish({ saved: [] }); // the previous test left it open
		render(FileEditorModal);
		let settled = false;
		const done = editWorkdirFiles({
			workdir: '/proj',
			files: ['plan/x/phase-01-setup.md'],
			title: 'Plan'
		}).then((r) => {
			settled = true;
			return r;
		});
		await type('changed\n');
		await fireEvent.click(screen.getByText('Save'));
		// The checkpoint waits for the user: saving doesn't end it.
		await Promise.resolve();
		expect(settled).toBe(false);
		const commands = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
		expect(commands.every((c) => c === 'fs_read_text_full' || c === 'fs_write_text')).toBe(true);
		await fireEvent.click(screen.getByText('Done'));
		await expect(done).resolves.toEqual({ saved: ['plan/x/phase-01-setup.md'] });
	});
});
