import { describe, expect, it } from 'vitest';
import { auditJobType } from '#lib/agent/jobs/types/audit/definition.ts';
import { parseNotebookOutput, readNotebookOutput, runNotebookTitle } from './notebookOutput';

describe('notebook output setting', () => {
	it('reads a known mode and treats anything else as off', () => {
		expect(parseNotebookOutput('new')).toBe('new');
		expect(parseNotebookOutput('every')).toBe('off');
		expect(parseNotebookOutput(undefined)).toBe('off');
		expect(readNotebookOutput(JSON.stringify({ notebook_output: 'new' }))).toBe('new');
		expect(readNotebookOutput(JSON.stringify({ num_runs: 3 }))).toBe('off');
		expect(readNotebookOutput('not json')).toBe('off');
		expect(readNotebookOutput(null)).toBe('off');
	});

	it("survives a round trip through the audit job's config, and off isn't stored", () => {
		const config = { ...auditJobType.configDefaults(), notebook_output: 'new' };
		const json = auditJobType.configToJson(config);
		expect(readNotebookOutput(json)).toBe('new');
		expect(auditJobType.configFromJob(json).notebook_output).toBe('new');

		const off = auditJobType.configToJson(auditJobType.configDefaults());
		expect(JSON.parse(off!)).not.toHaveProperty('notebook_output');
		expect(auditJobType.configFromJob(off).notebook_output).toBe('off');
	});

	it('names the notebook after the job and when the run finished', () => {
		const title = runNotebookTitle('Security audit', new Date(2026, 10, 27, 14, 5));
		expect(title).toMatch(/^Security audit · /);
		expect(title).toContain('2026');
		expect(runNotebookTitle('  ', new Date(2026, 0, 1))).toMatch(/^Job · /);
	});
});
