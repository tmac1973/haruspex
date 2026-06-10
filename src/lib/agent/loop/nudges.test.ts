import { describe, it, expect } from 'vitest';
import { NudgeState, RUN_PYTHON_FAILURE_NUDGE_THRESHOLD } from './nudges';

const HINT_MARKER = '[Haruspex hint]';

describe('NudgeState.maybeAppendRunPythonHint', () => {
	it('appends the step-back hint after the threshold of "Error:" failures', () => {
		const n = new NudgeState();
		let last = '';
		for (let i = 0; i < RUN_PYTHON_FAILURE_NUDGE_THRESHOLD; i++) {
			last = n.maybeAppendRunPythonHint('Error: boom');
		}
		expect(last).toContain(HINT_MARKER);
	});

	it('counts pre-run lint failures toward the streak (regression: lint loop)', () => {
		const n = new NudgeState();
		const lintFail =
			'Lint failed before running (ruff caught 1 issue). No code was executed:\n' +
			'  line 27 [F541]: f-string without any placeholders';
		let last = '';
		for (let i = 0; i < RUN_PYTHON_FAILURE_NUDGE_THRESHOLD; i++) {
			last = n.maybeAppendRunPythonHint(lintFail);
		}
		expect(last).toContain(HINT_MARKER);
	});

	it('does not nudge before the threshold', () => {
		const n = new NudgeState();
		let last = '';
		for (let i = 0; i < RUN_PYTHON_FAILURE_NUDGE_THRESHOLD - 1; i++) {
			last = n.maybeAppendRunPythonHint('Error: boom');
		}
		expect(last).not.toContain(HINT_MARKER);
	});

	it('resets the streak on a successful result', () => {
		const n = new NudgeState();
		n.maybeAppendRunPythonHint('Error: boom');
		n.maybeAppendRunPythonHint('Lint failed before running (ruff caught 1 issue).');
		n.maybeAppendRunPythonHint('Stdout:\nok'); // success resets
		const after = n.maybeAppendRunPythonHint('Error: boom again');
		expect(after).not.toContain(HINT_MARKER);
	});
});
