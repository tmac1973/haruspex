import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REMOTE, seed, useScenario, byText } from '../helpers.mjs';

/**
 * An audit run records what each sample spent. Run 91, a real audit, closed
 * every step with no token figures; this runs one in the built app, against a
 * model that submits no findings, and reads the run back through the app's
 * own database command.
 */
describe('an audit run', () => {
	const dir = mkdtempSync(join(tmpdir(), 'haruspex-e2e-audit-'));
	after(() => rmSync(dir, { recursive: true, force: true }));

	it('records the tokens each sample spent', async () => {
		await useScenario('audit-empty');
		await seed(REMOTE);

		await (await $('button=Jobs')).click();
		await (await $('button=+ New')).click();
		await (await $('select.type-select')).selectByVisibleText('Audit');
		await (await $('input[placeholder="Morning headlines"]')).setValue('E2E audit');
		const workdir = await $('input.workdir-input');
		if (!(await workdir.isDisplayed())) await (await byText('Where & when')).click();
		await workdir.setValue(dir);
		await (
			await $('textarea[placeholder^="e.g. Find every instance"]')
		).setValue('Find duplicated logic.');
		await (await $('input[aria-label="Number of runs"]')).setValue('2');
		await (await $('button=Save')).click();
		await (await $('button[title^="Run now"]')).click();

		const run = await browser.waitUntil(
			async () => {
				const r = await browser.execute(async () => {
					const invoke = window.__TAURI_INTERNALS__.invoke;
					const jobs = await invoke('db_list_jobs');
					const job = jobs.find((j) => j.name === 'E2E audit');
					if (!job) return null;
					const runs = await invoke('db_list_job_runs', { jobId: job.id });
					return runs[0] ? invoke('db_get_job_run', { runId: runs[0].id }) : null;
				});
				return r && r.status === 'succeeded' ? r : false;
			},
			{ timeout: 60_000, timeoutMsg: 'the audit run never succeeded' }
		);

		const samples = run.steps.slice(0, -1);
		expect(samples).toHaveLength(2);
		for (const s of samples) {
			expect({ step: s.ordering, calls: s.stats?.model_calls ?? null }).toEqual({
				step: s.ordering,
				calls: 1
			});
		}
	});
});
