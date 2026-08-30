import { describe, it, expect } from 'vitest';
import { MAX_TRUNCATION_RETRIES, NudgeState, RUN_PYTHON_FAILURE_NUDGE_THRESHOLD } from './nudges';

const HINT_MARKER = '[Haruspex hint]';

describe('NudgeState run_command repeat guard', () => {
	it('hints on the second identical command and hard-stops on the third', () => {
		const n = new NudgeState();
		const first = n.maybeAppendRunCommandHint('./my-gui', 'Exit code: 0 — command succeeded');
		expect(first).not.toContain(HINT_MARKER);
		expect(n.shouldStopForCommandRepeat()).toBe(false);

		const second = n.maybeAppendRunCommandHint('./my-gui', 'Exit code: 0 — command succeeded');
		expect(second).toContain(HINT_MARKER);
		expect(n.shouldStopForCommandRepeat()).toBe(false);

		n.maybeAppendRunCommandHint('./my-gui', 'Exit code: 0 — command succeeded');
		expect(n.shouldStopForCommandRepeat()).toBe(true);
	});

	it('does not trip when the command changes', () => {
		const n = new NudgeState();
		n.maybeAppendRunCommandHint('npm test', 'ok');
		const other = n.maybeAppendRunCommandHint('npm run build', 'ok');
		expect(other).not.toContain(HINT_MARKER);
		expect(n.shouldStopForCommandRepeat()).toBe(false);
	});

	it('resets the streak when another tool runs in between (real progress)', () => {
		const n = new NudgeState();
		n.maybeAppendRunCommandHint('npm test', 'fail');
		n.noteNonRunCommandTool(); // e.g. an fs_edit_text fixed the code
		const again = n.maybeAppendRunCommandHint('npm test', 'fail');
		expect(again).not.toContain(HINT_MARKER);
		expect(n.shouldStopForCommandRepeat()).toBe(false);
	});
});

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

describe('NudgeState truncation retry budget', () => {
	it('allows exactly MAX_TRUNCATION_RETRIES retries, then refuses', () => {
		const n = new NudgeState();
		for (let i = 0; i < MAX_TRUNCATION_RETRIES; i++) {
			expect(n.needsTruncationRetry()).toBe(true);
			n.consumeTruncationRetry();
		}
		// Budget exhausted: the loop must stop asking and fail the turn instead
		// of burning every remaining iteration on the same oversized call.
		expect(n.needsTruncationRetry()).toBe(false);
		expect(n.truncationRetryCount).toBe(MAX_TRUNCATION_RETRIES);
	});

	it('tracks truncation and file-write budgets independently', () => {
		const n = new NudgeState();
		n.consumeTruncationRetry();
		expect(n.fileWriteRetryCount).toBe(0);
		n.consumeFileWriteNudge();
		expect(n.truncationRetryCount).toBe(1);
	});
});

describe('research nudge', () => {
	it('fires when the only tool used was image_search', () => {
		const n = new NudgeState();
		n.markImageSearchUsed();
		expect(n.needsResearchNudge(true, false)).toBe(true);
	});

	it('does not fire once a web_search has happened', () => {
		const n = new NudgeState();
		n.markImageSearchUsed();
		n.markWebSearchUsed();
		expect(n.needsResearchNudge(true, false)).toBe(false);
	});

	it('does not fire once a page has been fetched', () => {
		const n = new NudgeState();
		n.markImageSearchUsed();
		n.recordFetchedUrl('https://example.com');
		expect(n.needsResearchNudge(true, false)).toBe(false);
	});

	it('does not fire when no image_search happened', () => {
		const n = new NudgeState();
		expect(n.needsResearchNudge(true, false)).toBe(false);
	});

	// Someone who asked only for a picture has been served. Nudging them into
	// researching a topic they never asked about would be worse than the bug.
	it('does not fire for a request images alone can satisfy', () => {
		const n = new NudgeState();
		n.markImageSearchUsed();
		expect(n.needsResearchNudge(true, true)).toBe(false);
	});

	it('fires at most once per turn', () => {
		const n = new NudgeState();
		n.markImageSearchUsed();
		expect(n.needsResearchNudge(true, false)).toBe(true);
		n.consumeResearchNudge();
		expect(n.needsResearchNudge(true, false)).toBe(false);
	});
});
