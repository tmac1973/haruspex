import { describe, it, expect } from 'vitest';
import { editWorkdirFiles, getPendingEdit } from './fileEditor.svelte';

const request = { workdir: '/proj', files: ['plan/a/overview.md'], title: 'Overview' };

describe('editWorkdirFiles', () => {
	it('stays open until the modal finishes, then reports what was saved', async () => {
		const done = editWorkdirFiles(request);
		const pending = getPendingEdit();
		expect(pending?.files).toEqual(['plan/a/overview.md']);
		pending!.finish({ saved: ['plan/a/overview.md'] });
		await expect(done).resolves.toEqual({ saved: ['plan/a/overview.md'] });
		expect(getPendingEdit()).toBeNull();
	});

	it('closes and rejects when the job is cancelled', async () => {
		const abort = new AbortController();
		const done = editWorkdirFiles(request, abort.signal);
		abort.abort();
		await expect(done).rejects.toThrow('Aborted');
		expect(getPendingEdit()).toBeNull();
	});

	it('refuses a second editor while one is open', async () => {
		const first = editWorkdirFiles(request);
		await expect(editWorkdirFiles(request)).rejects.toThrow('already open');
		getPendingEdit()!.finish({ saved: [] });
		await first;
	});
});
