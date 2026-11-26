import { describe, it, expect } from 'vitest';
import { receiptFor } from './receipt';

describe('receiptFor', () => {
	it('sizes any result', () => {
		expect(receiptFor('one line')).toBe('1 line, 8 B.');
		expect(receiptFor('a\nb\n' + 'x'.repeat(2048))).toBe('3 lines, 2.0 KB.');
	});

	it("reads a failing pytest run off run_command's output", () => {
		const out = [
			'Exit code: 1 (2140ms)',
			'tests/test_a.py .F',
			'E       AssertionError: assert 3 == 4',
			'=========== 1 failed, 86 passed in 2.10s ==========='
		].join('\n');
		const r = receiptFor(out);
		expect(r).toContain('Exit code 1');
		expect(r).toContain('Tests: 86 passed, 1 failed');
		expect(r).toContain('First error (AssertionError): «E       AssertionError: assert 3 == 4»');
	});

	it("reads vitest's and cargo's totals", () => {
		expect(receiptFor('      Tests  2 failed | 40 passed (42)')).toContain(
			'Tests: 40 passed, 2 failed'
		);
		expect(receiptFor('test result: ok. 12 passed; 0 failed; 1 ignored')).toContain(
			'Tests: 12 passed, 0 failed'
		);
	});

	it('does not take a summary of zero failures for an error', () => {
		expect(receiptFor('test result: ok. 12 passed; 0 failed')).not.toContain('First error');
	});

	it('names a killed command, a tool error, a page and a spill file', () => {
		expect(receiptFor('Command killed (timeout or cancellation) after 600000ms.')).toContain(
			'Killed (timeout or cancel)'
		);
		expect(receiptFor('{"error":"fs_read_text failed: no such file"}')).toContain(
			'Error: «fs_read_text failed: no such file»'
		);
		expect(receiptFor('[Source: https://example.com/a]\n\nText')).toContain(
			'Source: https://example.com/a'
		);
		expect(
			receiptFor('x\nFull output (91234 bytes) saved to /tmp/haruspex-run-output-1.txt — read it')
		).toContain('Full output in /tmp/haruspex-run-output-1.txt');
	});

	it('stays short however long the error line is', () => {
		expect(receiptFor('error: ' + 'x'.repeat(2000)).length).toBeLessThanOrEqual(320);
	});
});
