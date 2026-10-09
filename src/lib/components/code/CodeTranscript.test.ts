import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import type { ChatMessage } from '#lib/api.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('#lib/stores/chat.svelte.ts', () => ({
	rerunSandboxStep: vi.fn(),
	cancelActiveSandboxRun: vi.fn()
}));

import CodeTranscript from './CodeTranscript.svelte';
import type { CodeSession } from '#lib/stores/code.svelte.ts';

/** The fields the transcript reads, on a plain object. */
function fakeSession(over: Partial<Record<string, unknown>> = {}): CodeSession {
	return {
		id: 's1',
		root: '/p/app',
		messages: [],
		messageSteps: {},
		messageStats: {},
		messageStops: {},
		status: 'idle',
		busy: false,
		ticket: null,
		steering: [],
		steeringDelivered: [],
		searchSteps: [],
		streamingContent: '',
		lastError: null,
		saveError: null,
		contextNotice: null,
		continueTurn: vi.fn(),
		...over
	} as unknown as CodeSession;
}

function thread(turns: number): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (let t = 1; t <= turns; t++) {
		out.push({ role: 'user', content: `question ${t}` });
		out.push({ role: 'assistant', content: `answer ${t}` });
	}
	return out;
}

describe('CodeTranscript steering', () => {
	it('shows delivered and queued steering, and drops a queued one on ×', async () => {
		const session = fakeSession({
			status: 'running',
			busy: true,
			steeringDelivered: ['use the other API'],
			steering: ['and add a test']
		});
		render(CodeTranscript, { session });
		expect(screen.getByText('use the other API').closest('.steer')!.textContent).toContain(
			'Delivered'
		);
		expect(screen.getByText('and add a test').closest('.steer')!.textContent).toContain('Queued');
		await fireEvent.click(screen.getByRole('button', { name: 'Remove queued message' }));
		expect(session.steering).toEqual([]);
	});

	it('says when the turn is queued behind another', () => {
		render(CodeTranscript, { session: fakeSession({ status: 'queued', busy: true }) });
		expect(screen.getByText('Waiting for another turn to finish…')).toBeTruthy();
	});
});

describe('CodeTranscript render window', () => {
	it('renders the last 20 turns of a long session, and earlier ones on request', async () => {
		render(CodeTranscript, { session: fakeSession({ messages: thread(25) }) });
		expect(screen.queryByText('question 5')).toBeNull();
		expect(screen.getByText('question 6')).toBeTruthy();
		expect(screen.getByText('answer 25')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Show earlier (5 more turns)' }));
		expect(screen.getByText('question 1')).toBeTruthy();
		expect(screen.queryByRole('button', { name: /Show earlier/ })).toBeNull();
	});

	it('shows a short session whole', () => {
		render(CodeTranscript, { session: fakeSession({ messages: thread(3) }) });
		expect(screen.getByText('question 1')).toBeTruthy();
		expect(screen.queryByRole('button', { name: /Show earlier/ })).toBeNull();
	});
});

describe('CodeTranscript tool cards', () => {
	it('shows an edit as a diff card and a command as a command card', () => {
		const messages: ChatMessage[] = [
			{ role: 'user', content: 'fix it' },
			{ role: 'assistant', content: 'Fixed.' }
		];
		const messageSteps = {
			1: [
				{
					id: 'e1',
					toolName: 'fs_edit_text',
					query: 'a.ts',
					status: 'done',
					args: { path: 'a.ts', old_str: 'let x = 1;', new_str: 'let x = 2;' },
					result: 'Edited a.ts (line 7)'
				},
				{
					id: 'c1',
					toolName: 'run_command',
					query: 'npm test',
					status: 'done',
					args: { command: 'npm test' },
					result: 'Exit code: 0 (10ms)\npassed'
				}
			]
		};
		render(CodeTranscript, { session: fakeSession({ messages, messageSteps }) });
		const diff = screen.getByTestId('diff-card');
		expect(diff.textContent).toContain('let x = 2;');
		expect(diff.textContent).toContain('+1');
		expect(screen.getByTestId('command-card').textContent).toContain('passed');
	});
});

describe('CodeTranscript live tool round', () => {
	it('shows the round being written and the calls it is writing', () => {
		const session = fakeSession({
			status: 'running',
			busy: true,
			roundText: '<think>Read the file first.',
			pendingToolCalls: [
				{
					index: 0,
					id: 'w',
					name: 'fs_write_text',
					argsSoFar: `{"path":"src/foo.ts","content":"${'x'.repeat(4300)}`
				},
				{ index: 1, id: 'r', name: 'run_command', argsSoFar: '{"command":"npm test' }
			]
		});
		render(CodeTranscript, { session });
		expect(screen.getByText('Read the file first.')).toBeTruthy();
		const rows = screen
			.getAllByTestId('pending-call')
			.map((r) => r.textContent?.replace(/\s+/g, ' ').trim());
		expect(rows[0]).toContain('Writing src/foo.ts… 4.2 KB');
		expect(rows[1]).toContain('Preparing command…');
		expect(screen.getByText('npm test')).toBeTruthy();
	});

	it('shows the reasoning behind a step above it', () => {
		const session = fakeSession({
			status: 'running',
			busy: true,
			searchSteps: [
				{
					id: 'a',
					toolName: 'code_grep',
					query: 'foo',
					status: 'running',
					reasoning: 'Find where foo is defined.'
				}
			]
		});
		render(CodeTranscript, { session });
		expect(screen.getByText('Find where foo is defined.')).toBeTruthy();
	});

	it('shows what the model said with its calls once, as markdown, above the steps', () => {
		const said = 'The **import** is wrong. Fixing it.';
		const messages: ChatMessage[] = [
			{ role: 'user', content: 'fix it' },
			{
				role: 'assistant',
				content: said,
				tool_calls: [
					{ id: 'g', type: 'function', function: { name: 'code_grep', arguments: '{}' } }
				]
			},
			{ role: 'tool', tool_call_id: 'g', content: 'a.ts:1' },
			{ role: 'assistant', content: 'Fixed.' }
		];
		const messageSteps = {
			3: [
				{
					id: 'g',
					toolName: 'code_grep',
					query: 'import',
					status: 'done' as const,
					result: 'a.ts:1',
					lead: said
				}
			]
		};
		const { container } = render(CodeTranscript, {
			session: fakeSession({ messages, messageSteps })
		});
		const bold = screen.getAllByText('import').filter((el) => el.tagName === 'STRONG');
		expect(bold).toHaveLength(1);
		expect(container.textContent?.split('Fixing it.').length).toBe(2);
		// Above the step, and the answer after both.
		const text = container.textContent ?? '';
		expect(text.indexOf('Fixing it.')).toBeLessThan(text.indexOf('Fixed.'));
	});
});

describe('slash command notes', () => {
	it('stay where they were added, above what was sent after them', () => {
		const messages: ChatMessage[] = [
			{ role: 'user', content: 'first ask' },
			{ role: 'assistant', content: 'first answer' },
			{ role: 'user', content: 'later ask' },
			{ role: 'assistant', content: 'later answer' }
		];
		const session = fakeSession({ messages });
		render(CodeTranscript, { session, notes: [{ text: 'SKILLS LIST', at: 2 }] });
		const text = screen.getByTestId('code-transcript').textContent ?? '';
		expect(text.indexOf('first answer')).toBeLessThan(text.indexOf('SKILLS LIST'));
		expect(text.indexOf('SKILLS LIST')).toBeLessThan(text.indexOf('later ask'));
	});
});

describe('CodeTranscript and the shell', () => {
	it('shows the wait with Go to shell and Cancel', async () => {
		const goToShell = vi.fn();
		const cancelShellWait = vi.fn();
		render(CodeTranscript, {
			session: fakeSession({
				status: 'waiting-shell',
				busy: true,
				shellWait: { shellName: 'Shell 2', command: 'sudo x', focus: vi.fn(), cancel: vi.fn() },
				goToShell,
				cancelShellWait
			})
		});
		expect(screen.getByTestId('shell-wait').textContent).toContain(
			'Waiting for you in Shell 2 — press Enter there.'
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Go to shell' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(goToShell).toHaveBeenCalledOnce();
		expect(cancelShellWait).toHaveBeenCalledOnce();
	});
});

describe('CodeTranscript paths', () => {
	it('opens a path in an answer in the editor; paths outside the folder are plain', async () => {
		const { getPendingEdit } = await import('#lib/stores/fileEditor.svelte.ts');
		const { container } = render(CodeTranscript, {
			session: fakeSession({
				messages: [
					{ role: 'user', content: 'where?' },
					{ role: 'assistant', content: 'In `src/app.ts:12`, not /etc/hosts.conf.' }
				]
			})
		});
		const links = container.querySelectorAll<HTMLButtonElement>('button.code-path');
		expect([...links].map((b) => b.dataset.path)).toEqual(['src/app.ts']);
		await fireEvent.click(links[0].querySelector('code')!);
		expect(getPendingEdit()).toMatchObject({ workdir: '/p/app', files: ['src/app.ts'] });
		getPendingEdit()!.finish({ saved: [] });
	});

	it('links the file of a diff card and a read step', async () => {
		const { getPendingEdit } = await import('#lib/stores/fileEditor.svelte.ts');
		render(CodeTranscript, {
			session: fakeSession({
				messages: [
					{ role: 'user', content: 'go' },
					{ role: 'assistant', content: 'done' }
				],
				messageSteps: {
					1: [
						{
							id: 'r1',
							toolName: 'fs_read_text',
							query: 'src/a.ts',
							status: 'done',
							args: { path: 'src/a.ts' },
							result: 'x'
						},
						{
							id: 'e1',
							toolName: 'fs_edit_text',
							query: 'src/b.ts',
							status: 'done',
							args: { path: 'src/b.ts', old_str: 'a', new_str: 'b' },
							result: 'Edited src/b.ts at line 3'
						}
					]
				}
			})
		});
		await fireEvent.click(screen.getByRole('button', { name: 'src/a.ts' }));
		expect(getPendingEdit()?.files).toEqual(['src/a.ts']);
		getPendingEdit()!.finish({ saved: [] });
		await fireEvent.click(screen.getByTitle('Open src/b.ts in the editor'));
		expect(getPendingEdit()?.files).toEqual(['src/b.ts']);
		getPendingEdit()!.finish({ saved: [] });
	});

	it('links grep hits inside the folder', async () => {
		const { getPendingEdit } = await import('#lib/stores/fileEditor.svelte.ts');
		const { container } = render(CodeTranscript, {
			session: fakeSession({
				messages: [
					{ role: 'user', content: 'go' },
					{ role: 'assistant', content: 'done' }
				],
				messageSteps: {
					1: [
						{
							id: 'g1',
							toolName: 'code_grep',
							query: 'parse',
							status: 'done',
							args: { pattern: 'parse' },
							result: 'src/c.ts:4: parse()\n../x/d.ts:1: parse()'
						}
					]
				}
			})
		});
		await fireEvent.click(container.querySelector('.step')!);
		const pre = container.querySelector('.detail-block pre')!;
		expect(pre.textContent).toBe('src/c.ts:4: parse()\n../x/d.ts:1: parse()');
		const links = pre.querySelectorAll('button.path-link');
		expect([...links].map((b) => b.textContent)).toEqual(['src/c.ts']);
		await fireEvent.click(links[0]);
		expect(getPendingEdit()?.files).toEqual(['src/c.ts']);
		getPendingEdit()!.finish({ saved: [] });
	});
});
