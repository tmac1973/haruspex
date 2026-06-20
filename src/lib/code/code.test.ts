import { describe, it, expect } from 'vitest';
import { buildCodeSystemPrompt } from '$lib/code/system-prompt';
import {
	getCodeWorkingDir,
	setCodeWorkingDir,
	getCodeMessages,
	getCodeError,
	submitCodeMessage
} from '$lib/stores/code.svelte';

describe('buildCodeSystemPrompt', () => {
	it('names the project root and the lean toolset', () => {
		const msg = buildCodeSystemPrompt('/home/me/project');
		expect(msg.role).toBe('system');
		const text = typeof msg.content === 'string' ? msg.content : '';
		expect(text).toContain('/home/me/project');
		for (const tool of ['code_grep', 'code_glob', 'fs_read_text', 'fs_edit_text', 'run_command']) {
			expect(text).toContain(tool);
		}
		expect(text).toContain('SCRATCHPAD');
	});
});

describe('code session store', () => {
	it('tracks the working directory', () => {
		setCodeWorkingDir('/tmp/proj');
		expect(getCodeWorkingDir()).toBe('/tmp/proj');
		setCodeWorkingDir(null);
		expect(getCodeWorkingDir()).toBeNull();
	});

	it('refuses to submit without a working directory', async () => {
		setCodeWorkingDir(null);
		await submitCodeMessage('do something');
		expect(getCodeError()).toMatch(/project directory/i);
		expect(getCodeMessages()).toHaveLength(0);
	});
});
