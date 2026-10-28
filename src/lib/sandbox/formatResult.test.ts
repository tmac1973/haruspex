import { describe, expect, it } from 'vitest';
import {
	formatSandboxResult,
	SANDBOX_OUTPUT_MAX_BYTES,
	type SandboxRunOutput
} from './formatResult.ts';

const base: SandboxRunOutput = {
	stdout: '',
	stderr: '',
	result: '',
	error: null,
	artifacts: 0,
	notes: [],
	duration_ms: 5
};

describe('formatSandboxResult', () => {
	it('passes small output through whole', () => {
		const text = formatSandboxResult({ ...base, stdout: 'hello\n', result: '42' });
		expect(text).toContain('Stdout:\nhello');
		expect(text).toContain('Result: 42');
		expect(text).not.toContain('middle truncated');
	});

	it('cuts a huge stdout to its head and tail', () => {
		const stdout = Array.from({ length: 30000 }, (_, i) => `{"mod":${i}}`).join('\n');
		const text = formatSandboxResult({ ...base, stdout });
		expect(text.length).toBeLessThan(SANDBOX_OUTPUT_MAX_BYTES + 1024);
		expect(text).toContain('{"mod":0}');
		expect(text).toContain('{"mod":29999}');
		expect(text).toContain('middle truncated');
		expect(text).toContain('print a filtered slice');
		expect(text).not.toContain('narrow the command');
	});

	it('caps the final value and stderr of a failed run too', () => {
		const huge = 'x'.repeat(SANDBOX_OUTPUT_MAX_BYTES * 10);
		const ok = formatSandboxResult({ ...base, result: huge });
		expect(ok.length).toBeLessThan(SANDBOX_OUTPUT_MAX_BYTES + 1024);
		const failed = formatSandboxResult({ ...base, error: 'Boom', stderr: huge, stdout: huge });
		expect(failed.length).toBeLessThan(2 * SANDBOX_OUTPUT_MAX_BYTES + 2048);
		expect(failed).toContain('Error: Boom');
	});
});
