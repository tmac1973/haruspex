import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const opened = vi.hoisted(() => ({ openJobDraft: vi.fn() }));
vi.mock('#lib/agent/jobs/openDraft.ts', () => opened);
const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => tauri);

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { PROPOSABLE_TYPES } from './propose-job';
import type { ToolContext } from './types';
import { makeToolContext } from '#lib/testing/toolContext.ts';

beforeAll(async () => {
	await import('#lib/agent/jobs/types/index.ts');
}, 60_000);

function ctx(over: Partial<ToolContext> = {}): ToolContext {
	return makeToolContext({ interactive: true, ...over });
}

const offered = (opts: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(opts).some((s) => s.function.name === 'propose_job');

beforeEach(() => {
	opened.openJobDraft.mockReset().mockResolvedValue(undefined);
	tauri.invoke.mockReset().mockImplementation(async (cmd: string) => {
		if (cmd === 'fs_path_exists') return false;
		if (cmd === 'shell_platform_supported') return true;
		return null;
	});
});

describe('propose_job', () => {
	it('is offered in Chat and the Code tab, to someone at this computer', () => {
		expect(offered({ hasWorkingDir: false, interactive: true })).toBe(true);
		expect(offered({ hasWorkingDir: true, interactive: true, codeMode: true })).toBe(true);
		expect(offered({ hasWorkingDir: false, interactive: false })).toBe(false);
		expect(offered({ hasWorkingDir: true, interactive: true, shellMode: true })).toBe(false);
		expect(
			offered({ hasWorkingDir: true, interactive: true, codeMode: true, shellMode: true })
		).toBe(false);
		expect(
			offered({ hasWorkingDir: true, interactive: true, codeMode: true, codeRemote: true })
		).toBe(false);
		expect(offered({ hasWorkingDir: true, interactive: true, subtask: true })).toBe(false);
		expect(
			offered({ hasWorkingDir: true, interactive: true, toolAllowlist: ['propose_job'] })
		).toBe(true);
	});

	it('names every job type that can be proposed, and no other', async () => {
		const { listJobTypes } = await import('#lib/agent/jobs/types/index.ts');
		expect([...PROPOSABLE_TYPES].sort()).toEqual(
			listJobTypes()
				.filter((t) => t.propose)
				.map((t) => t.id)
				.sort()
		);
	});

	it("opens the draft in the Code tab's project, unsaved", async () => {
		const out = await executeTool(
			'propose_job',
			{ job_type: 'guided_planning', name: 'Todo app', brief: 'A todo app with tags.' },
			ctx({ codeMode: true, workingDir: '/code/todo' })
		);
		expect(out.result).toMatch(/Opened a new Guided planning job, "Todo app"/);
		expect(out.result).toMatch(/nothing runs until the user saves it and presses Run/);
		const draft = opened.openJobDraft.mock.calls[0][0];
		expect(draft).toMatchObject({
			jobType: 'guided_planning',
			name: 'Todo app',
			workingDir: '/code/todo',
			config: { initial_description: 'A todo app with tags.' }
		});
	});

	it('opens nothing when the job type rejects the draft', async () => {
		const out = await executeTool(
			'propose_job',
			{ job_type: 'research', name: 'X', brief: 'Look into X.' },
			ctx()
		);
		expect(out.result).toMatch(/Nothing was opened\. The job isn't ready/);
		expect(opened.openJobDraft).not.toHaveBeenCalled();
	});

	it('refuses a spec where one already exists', async () => {
		tauri.invoke.mockImplementation(async (cmd: string) => cmd === 'fs_path_exists');
		const spec = '{"style":"s","entries":[{"id":"rock","title":"Rock","height_m":1}]}';
		const out = await executeTool(
			'propose_job',
			{ job_type: 'model_generation', name: 'Props', spec },
			ctx({ workingDir: '/p' })
		);
		expect(opened.openJobDraft).not.toHaveBeenCalled();
		expect(out.result).toMatch(/assets\/haruspex-models\.json already exists/);
	});
});
