import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/approvalOverride.ts', () => ({ isAutoApproveActive: () => true }));

import { executeTool } from '#lib/agent/tools/index.ts';
import { createdScope } from '#lib/agent/tools/_created.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';

/** What the created-files store says for each path, as Rust would. */
const status = new Map<string, string>();
const disk = new Set<string>();

beforeEach(() => {
	status.clear();
	disk.clear();
	vi.mocked(invoke).mockReset();
	const rel = (a?: Record<string, unknown>) => String(a?.relPath);
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			fs_path_exists: (a) => disk.has(rel(a)),
			fs_created_status: (a) => status.get(rel(a)) ?? (disk.has(rel(a)) ? 'foreign' : 'missing'),
			fs_created_note: (a) => {
				status.set(rel(a), 'owned');
				return null;
			},
			fs_write_text: (a) => {
				disk.add(rel(a));
				return null;
			},
			fs_delete_created: null,
			fs_move_created: null
		})
	);
});

/** A job run's turn: it overwrites without asking, so both paths are reached. */
const job = () => makeToolContext({ workingDir: '/w', jobRunId: 7 });
const calls = (cmd: string) => vi.mocked(invoke).mock.calls.filter((c) => c[0] === cmd);

describe('the scope a turn keeps its files under', () => {
	it('is the job run, the Code session or the chat, and none in Shell', () => {
		expect(createdScope({ jobRunId: 7, conversationId: 'c' })).toBe('job:7');
		expect(createdScope({ codeSessionId: 's', conversationId: 'c' })).toBe('code:s');
		expect(createdScope({ conversationId: 'c' })).toBe('chat:c');
		expect(createdScope({ shellMode: true, conversationId: 'c' })).toBeNull();
	});
});

describe('writes keep the record', () => {
	it('records a file the turn creates', async () => {
		await executeTool('fs_write_text', { path: 'draft.md', content: '# Draft\n' }, job());
		expect(calls('fs_created_note')).toEqual([
			['fs_created_note', { workdir: '/w', relPath: 'draft.md', scope: 'job:7' }]
		]);
	});

	it("doesn't take over a file that was already there", async () => {
		disk.add('notes.md');
		await executeTool('fs_write_text', { path: 'notes.md', content: 'x\n' }, job());
		expect(calls('fs_created_note')).toEqual([]);
	});

	it("keeps an owned file's hash current when the agent rewrites it", async () => {
		disk.add('draft.md');
		status.set('draft.md', 'owned');
		await executeTool('fs_write_text', { path: 'draft.md', content: '# Draft 2\n' }, job());
		expect(calls('fs_created_note')).toHaveLength(1);
	});

	it('leaves a file the user changed as theirs', async () => {
		disk.add('draft.md');
		status.set('draft.md', 'changed');
		await executeTool('fs_write_text', { path: 'draft.md', content: '# Draft 2\n' }, job());
		expect(calls('fs_created_note')).toEqual([]);
	});
});

describe('fs_delete', () => {
	it('sends the file to the trash under the turn scope', async () => {
		const out = await executeTool('fs_delete', { path: 'plan/phase-01-x.md' }, job());
		expect(out.result).toBe('Moved plan/phase-01-x.md to the trash.');
		expect(calls('fs_delete_created')).toEqual([
			['fs_delete_created', { workdir: '/w', relPath: 'plan/phase-01-x.md', scope: 'job:7' }]
		]);
	});

	it('says where the file went when the system trash refused it', async () => {
		vi.mocked(invoke).mockImplementation(
			invokeRouter({ fs_delete_created: '.haruspex/trash/20261107T180000-draft.md' })
		);
		const out = await executeTool('fs_delete', { path: 'draft.md' }, job());
		expect(out.result).toBe(
			"The system trash wouldn't take draft.md, so it was moved to .haruspex/trash/20261107T180000-draft.md in the working folder."
		);
	});

	it("passes on Rust's refusal", async () => {
		vi.mocked(invoke).mockImplementation(
			invokeRouter({
				fs_delete_created: () => {
					throw "You didn't make notes.md in this conversation, so you can't remove or move it. Ask the user to.";
				}
			})
		);
		const out = await executeTool('fs_delete', { path: 'notes.md' }, job());
		expect(out.result).toContain("You didn't make notes.md in this conversation");
	});

	it('is refused in Shell, read-only Code and with no folder', async () => {
		const shell = makeToolContext({ workingDir: '/w', shellMode: true, conversationId: 'c' });
		expect((await executeTool('fs_delete', { path: 'a' }, shell)).result).toContain(
			"isn't available in Shell"
		);
		const ro = makeToolContext({ workingDir: '/w', codeSessionId: 's', codeReadOnly: true });
		expect((await executeTool('fs_delete', { path: 'a' }, ro)).result).toContain('read-only');
		const none = makeToolContext({ conversationId: 'c' });
		expect((await executeTool('fs_delete', { path: 'a' }, none)).result).toContain(
			'No working directory set'
		);
		expect(calls('fs_delete_created')).toEqual([]);
	});

	it('stays inside a write root', async () => {
		const ctx = makeToolContext({ workingDir: '/w', jobRunId: 7, writeRoot: 'plan/x/' });
		const out = await executeTool('fs_delete', { path: 'src/main.rs' }, ctx);
		expect(out.result).toMatch(/may only write inside plan\/x\//);
		expect(calls('fs_delete_created')).toEqual([]);
	});
});

describe('fs_move', () => {
	it('moves under the turn scope, and carries the turn record with it', async () => {
		const ctx = job();
		ctx.filesWrittenThisTurn.add('a.md');
		const out = await executeTool('fs_move', { from: 'a.md', to: 'docs/b.md' }, ctx);
		expect(out.result).toBe('Moved a.md to docs/b.md.');
		expect(calls('fs_move_created')).toEqual([
			['fs_move_created', { workdir: '/w', from: 'a.md', to: 'docs/b.md', scope: 'job:7' }]
		]);
		expect([...ctx.filesWrittenThisTurn]).toEqual(['docs/b.md']);
	});

	it('needs both paths', async () => {
		const out = await executeTool('fs_move', { from: 'a.md' }, job());
		expect(JSON.parse(out.result).error).toBe('fs_move needs "from" and "to".');
	});
});
