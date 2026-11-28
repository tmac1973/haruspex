import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import { invoke } from '@tauri-apps/api/core';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { workdirFiles } from './workdirFiles.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';

function ctxFor(working_dir: string | null): Pick<JobRunContext, 'job' | 'runId'> {
	return { job: { working_dir } as JobRunContext['job'], runId: 7 };
}

const calls = () => vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);

beforeEach(() => {
	vi.mocked(invoke).mockReset();
});

describe('workdirFiles', () => {
	it('reads in full, and null when the read fails', async () => {
		vi.mocked(invoke).mockImplementation(
			invokeRouter({
				fs_read_text_full: (a) => {
					if (a?.relPath === 'gone.md') throw new Error('no such file');
					return 'body';
				}
			})
		);
		const files = workdirFiles(ctxFor('/w'));
		expect(await files.readText('plan.md')).toBe('body');
		expect(await files.readText('gone.md')).toBeNull();
		expect(invoke).toHaveBeenCalledWith('fs_read_text_full', { workdir: '/w', relPath: 'plan.md' });
	});

	it('reads bytes and checks a path', async () => {
		vi.mocked(invoke).mockImplementation(
			invokeRouter({ fs_read_bytes: () => [1, 2], fs_path_exists: () => true })
		);
		const files = workdirFiles(ctxFor('/w'));
		expect(await files.readBytes('a.png')).toEqual(new Uint8Array([1, 2]));
		expect(await files.exists('a.png')).toBe(true);
	});

	it('reads nothing with no working folder', async () => {
		const files = workdirFiles(ctxFor(null));
		expect(await files.readText('plan.md')).toBeNull();
		expect(await files.readBytes('a.png')).toBeNull();
		expect(await files.exists('a.png')).toBe(false);
		expect(invoke).not.toHaveBeenCalled();
	});

	it('notes a new file as the run’s after writing it', async () => {
		vi.mocked(invoke).mockImplementation(invokeRouter({ fs_created_status: () => 'missing' }));
		await workdirFiles(ctxFor('/w')).writeText('TODO.md', '- [ ] one');
		expect(calls()).toEqual(['fs_created_status', 'fs_write_text', 'fs_created_note']);
		expect(invoke).toHaveBeenCalledWith('fs_write_text', {
			workdir: '/w',
			relPath: 'TODO.md',
			content: '- [ ] one',
			overwrite: true
		});
		expect(invoke).toHaveBeenCalledWith('fs_created_note', {
			workdir: '/w',
			relPath: 'TODO.md',
			scope: 'job:7'
		});
	});

	it('leaves a file the run did not make unclaimed', async () => {
		vi.mocked(invoke).mockImplementation(invokeRouter({ fs_created_status: () => 'foreign' }));
		await workdirFiles(ctxFor('/w')).writeBytes('a.png', new Uint8Array([9]));
		expect(calls()).toEqual(['fs_created_status', 'fs_write_bytes']);
	});

	it('resolves paths before every call', async () => {
		vi.mocked(invoke).mockImplementation(invokeRouter({ fs_created_status: () => 'missing' }));
		const files = workdirFiles(ctxFor('/w'), (rel) => `ep1/${rel}`);
		await files.writeText('spec.json', '{}');
		expect(invoke).toHaveBeenCalledWith(
			'fs_write_text',
			expect.objectContaining({ relPath: 'ep1/spec.json' })
		);
	});

	it('refuses to write with no working folder', async () => {
		await expect(workdirFiles(ctxFor(null)).writeText('TODO.md', 'x')).rejects.toThrow(
			'No working folder'
		);
		expect(invoke).not.toHaveBeenCalled();
	});
});
