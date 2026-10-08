import { describe, expect, it } from 'vitest';
import { formatDuration, parseCommandResult, stripAnsi, tailLines } from './commandResult';

describe('parseCommandResult', () => {
	it('reads the exit code, duration and output', () => {
		const v = parseCommandResult('Exit code: 2 (340ms)\nboom\n[stderr]\nbad');
		expect(v).toMatchObject({ exitCode: 2, durationMs: 340, killed: false });
		expect(v.output).toBe('boom\n[stderr]\nbad');
	});

	it('reads a command that succeeded with no output', () => {
		const v = parseCommandResult('Exit code: 0 (5ms) — command succeeded with no output.');
		expect(v).toMatchObject({ exitCode: 0, durationMs: 5, output: '' });
	});

	it('reads a killed command', () => {
		const v = parseCommandResult(
			'Command killed (timeout or cancellation) after 30000ms.\npartial'
		);
		expect(v).toMatchObject({ killed: true, durationMs: 30000, output: 'partial' });
	});

	it('reads a refusal and a background start', () => {
		expect(parseCommandResult('{"error":"Denied by the user."}').error).toBe('Denied by the user.');
		expect(parseCommandResult('Started in the background (id bg-1, PID 4).').background).toBe(true);
	});

	it('strips terminal colours from the output', () => {
		expect(parseCommandResult('Exit code: 0 (1ms)\n\x1b[32mok\x1b[0m').output).toBe('ok');
		expect(stripAnsi('\x1b]0;title\x07plain')).toBe('plain');
	});
});

describe('tailLines', () => {
	it('keeps short output whole', () => {
		expect(tailLines('a\nb\n', 5)).toEqual({ shown: 'a\nb', hidden: 0 });
	});

	it('keeps the last lines of long output', () => {
		const text = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
		const t = tailLines(text, 20);
		expect(t.hidden).toBe(10);
		expect(t.shown.split('\n')[0]).toBe('l10');
	});
});

describe('formatDuration', () => {
	it('scales the unit', () => {
		expect(formatDuration(850)).toBe('850 ms');
		expect(formatDuration(12_400)).toBe('12.4 s');
		expect(formatDuration(185_000)).toBe('3 min 5 s');
	});
});
