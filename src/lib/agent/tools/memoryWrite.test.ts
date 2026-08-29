import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	showToast: vi.fn(),
	askMemoryApproval: vi.fn(),
	memoryActive: vi.fn(() => true),
	settings: { memoryConfirmWrites: false, sandboxEnabled: false }
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('$lib/stores/toasts.svelte', () => ({ showToast: mocks.showToast }));
vi.mock('$lib/stores/memory.svelte', () => ({
	refreshMemoryCount: vi.fn(),
	memoryActive: mocks.memoryActive
}));
vi.mock('$lib/stores/session.svelte', () => ({ getActiveConversationId: () => 'conv-7' }));
vi.mock('$lib/stores/settings', () => ({
	getSettings: () => mocks.settings,
	hasEnabledEmailAccount: () => false
}));
vi.mock('$lib/debug-log', () => ({ logDebug: vi.fn() }));

const approval = vi.hoisted(() => ({ session: false }));
vi.mock('$lib/stores/memoryApproval.svelte', () => ({
	askMemoryApproval: mocks.askMemoryApproval,
	approveMemorySession: () => (approval.session = true),
	isMemorySessionApproved: () => approval.session
}));

import { executeTool, getToolSchemas } from './registry';
import './memoryWrite';
import { REMEMBER_TOOL } from './memoryWrite';
import type { ToolContext } from './types';

const ctx = {
	workingDir: null,
	pendingImages: [],
	deepResearch: false,
	filesWrittenThisTurn: new Set<string>(),
	shellMode: false,
	codeMode: false,
	codeAutoApprove: false
} as unknown as ToolContext;

const FACT = 'Deploys on Fridays.';

beforeEach(() => {
	vi.clearAllMocks();
	approval.session = false;
	mocks.settings.memoryConfirmWrites = false;
	mocks.memoryActive.mockReturnValue(true);
	// No near-duplicate by default.
	mocks.invoke.mockImplementation(async (cmd: string) =>
		cmd === 'memory_find_similar' ? null : undefined
	);
});

describe('remember_this exposure', () => {
	it('is offered in Chat when memory is active', () => {
		const names = getToolSchemas({ hasWorkingDir: false }).map((t) => t.function.name);
		expect(names).toContain(REMEMBER_TOOL);
	});

	it('is hidden when memory is off or its model is missing', () => {
		mocks.memoryActive.mockReturnValue(false);
		const names = getToolSchemas({ hasWorkingDir: false }).map((t) => t.function.name);
		expect(names).not.toContain(REMEMBER_TOOL);
	});

	// Shell and Code turns read files and command output constantly — the
	// surface where a planted "remember this" is most likely to arrive.
	it('is hidden in Shell and Code modes', () => {
		const shell = getToolSchemas({ hasWorkingDir: true, shellMode: true });
		const code = getToolSchemas({ hasWorkingDir: true, codeMode: true });
		expect(shell.map((t) => t.function.name)).not.toContain(REMEMBER_TOOL);
		expect(code.map((t) => t.function.name)).not.toContain(REMEMBER_TOOL);
	});

	// Schema filtering alone doesn't stop execution: executeTool resolves
	// against the full registry, and a small model can emit a call it was
	// never offered.
	it('refuses to run when memory is off, even if called anyway', async () => {
		mocks.memoryActive.mockReturnValue(false);
		const out = await executeTool(REMEMBER_TOOL, { content: FACT, category: 'fact' }, ctx);
		expect(out.result).toContain('Long-term memory is off');
		expect(mocks.invoke).not.toHaveBeenCalledWith('memory_add', expect.anything());
	});
});

describe('remember_this writing', () => {
	it('stores the fact with explicit origin and the active conversation', async () => {
		const out = await executeTool(REMEMBER_TOOL, { content: FACT, category: 'preference' }, ctx);
		expect(mocks.invoke).toHaveBeenCalledWith('memory_add', {
			content: FACT,
			category: 'preference',
			sourceConversationId: 'conv-7',
			origin: 'explicit'
		});
		expect(out.result).toContain('Saved to long-term memory');
	});

	it('shows the user exactly what was written', async () => {
		await executeTool(REMEMBER_TOOL, { content: FACT, category: 'fact' }, ctx);
		expect(mocks.showToast).toHaveBeenCalledWith(expect.stringContaining(FACT));
	});

	it('bumps a near-duplicate instead of storing it twice', async () => {
		mocks.invoke.mockImplementation(async (cmd: string) =>
			cmd === 'memory_find_similar' ? { id: 'mem-1', content: 'Ships on Fridays.' } : undefined
		);
		const out = await executeTool(REMEMBER_TOOL, { content: FACT, category: 'fact' }, ctx);
		expect(mocks.invoke).toHaveBeenCalledWith('memory_touch', { id: 'mem-1' });
		expect(mocks.invoke).not.toHaveBeenCalledWith('memory_add', expect.anything());
		expect(out.result).toContain('Already remembered');
	});

	it('rejects content too short or too long to be one fact', async () => {
		const short = await executeTool(REMEMBER_TOOL, { content: 'nope', category: 'fact' }, ctx);
		const long = await executeTool(
			REMEMBER_TOOL,
			{ content: 'x'.repeat(401), category: 'fact' },
			ctx
		);
		expect(short.result).toContain('between 8 and 400');
		expect(long.result).toContain('between 8 and 400');
		expect(mocks.invoke).not.toHaveBeenCalledWith('memory_add', expect.anything());
	});

	it('falls back to "fact" for an unknown category rather than storing it', async () => {
		await executeTool(REMEMBER_TOOL, { content: FACT, category: 'nonsense' }, ctx);
		expect(mocks.invoke).toHaveBeenCalledWith(
			'memory_add',
			expect.objectContaining({ category: 'fact' })
		);
	});

	it('reports a storage failure instead of claiming it saved', async () => {
		mocks.invoke.mockImplementation(async (cmd: string) => {
			if (cmd === 'memory_find_similar') return null;
			throw new Error('db is locked');
		});
		const out = await executeTool(REMEMBER_TOOL, { content: FACT, category: 'fact' }, ctx);
		expect(out.result).toContain('Could not save');
		expect(mocks.showToast).not.toHaveBeenCalled();
	});
});

describe('remember_this approval', () => {
	beforeEach(() => {
		mocks.settings.memoryConfirmWrites = true;
	});

	it('asks before writing, and writes on approval', async () => {
		mocks.askMemoryApproval.mockResolvedValue('allow_once');
		await executeTool(REMEMBER_TOOL, { content: FACT, category: 'fact' }, ctx);
		expect(mocks.askMemoryApproval).toHaveBeenCalledWith({ content: FACT, category: 'fact' });
		expect(mocks.invoke).toHaveBeenCalledWith('memory_add', expect.anything());
	});

	it('writes nothing when the user declines', async () => {
		mocks.askMemoryApproval.mockResolvedValue('deny');
		const out = await executeTool(REMEMBER_TOOL, { content: FACT, category: 'fact' }, ctx);
		expect(mocks.invoke).not.toHaveBeenCalledWith('memory_add', expect.anything());
		expect(mocks.showToast).not.toHaveBeenCalled();
		expect(out.result).toContain('declined');
	});

	it('stops asking for the rest of the session after allow_session', async () => {
		mocks.askMemoryApproval.mockResolvedValue('allow_session');
		await executeTool(REMEMBER_TOOL, { content: FACT, category: 'fact' }, ctx);
		await executeTool(REMEMBER_TOOL, { content: 'Uses fish as a shell.', category: 'fact' }, ctx);
		expect(mocks.askMemoryApproval).toHaveBeenCalledTimes(1);
	});

	it('skips the prompt entirely when the user turned it off', async () => {
		mocks.settings.memoryConfirmWrites = false;
		await executeTool(REMEMBER_TOOL, { content: FACT, category: 'fact' }, ctx);
		expect(mocks.askMemoryApproval).not.toHaveBeenCalled();
		expect(mocks.invoke).toHaveBeenCalledWith('memory_add', expect.anything());
	});
});
