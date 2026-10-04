import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REMOTE, seed, useScenario, byText } from '../helpers.mjs';

/**
 * A tool call reaching the real filesystem: a research job whose working
 * directory is a fresh temp folder runs the write-file scenario, in which the
 * model calls fs_write_text. A job, not Chat, because a job's working
 * directory is a text field and Chat's is a native folder dialog.
 */
describe('a tool call that writes to disk', () => {
	const dir = mkdtempSync(join(tmpdir(), 'haruspex-e2e-'));
	after(() => rmSync(dir, { recursive: true, force: true }));

	it('writes the file the model asked for, inside the working directory', async () => {
		await useScenario('write-file');
		await seed(REMOTE);

		await (await $('button=Jobs')).click();
		await (await $('button=+ New')).click();
		await (await $('input[placeholder="Morning headlines"]')).setValue('Write notes');
		const workdir = await $('input.workdir-input');
		if (!(await workdir.isDisplayed())) await (await byText('Where & when')).click();
		await workdir.setValue(dir);
		await (
			await $('textarea[placeholder="What should this step do?"]')
		).setValue('Please write the notes file.');
		await (await $('button=Save')).click();
		await (await $('button[title^="Run now"]')).click();

		const file = join(dir, 'notes.txt');
		await browser.waitUntil(() => existsSync(file), {
			timeout: 30_000,
			timeoutMsg: `the model's fs_write_text never produced ${file}`
		});
		expect(readFileSync(file, 'utf8')).toBe('written by the e2e scenario\n');
		await (await byText('I wrote notes.txt.')).waitForDisplayed({ timeout: 30_000 });
	});
});
