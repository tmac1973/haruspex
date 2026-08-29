import { describe, it, expect, beforeEach, vi } from 'vitest';

// Same isolation as the shell store's own tests: we're exercising the
// registry + handoff, not the inference pipeline or the Tauri boundary.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('$lib/shell/runShellTurn', () => ({ runShellTurn: vi.fn() }));
vi.mock('$lib/shell/system-prompt', () => ({
	buildShellSystemPrompt: () => ({ role: 'system', content: 'sys' })
}));
vi.mock('$lib/stores/settings', () => ({
	getSettings: () => ({
		shellCodeModeDefault: false,
		shellHistoryTurnsForPrompt: 3,
		shellMaxBytesPerCapture: 1000,
		contextSize: 8192,
		inferenceBackend: { mode: 'local' }
	}),
	getActiveLocalModelFilename: () => '',
	getApiKeyValue: () => undefined
}));
vi.mock('$lib/agent/tools', () => ({ getDisplayLabel: () => 'tool' }));
vi.mock('$lib/agent/context-budget', () => ({ describeContextManaged: () => 'managed' }));
vi.mock('$lib/debug-log', () => ({ logDebug: vi.fn() }));

import { openShellFromChat } from './fromChat';
import { getShellSessions, closeShellSession, getActiveShellId } from '$lib/stores/shell.svelte';
import { getActiveTab, setActiveTab } from '$lib/stores/activeTab.svelte';
import type { ChatMessage } from '$lib/api';

beforeEach(() => {
	for (const s of [...getShellSessions()]) closeShellSession(s.id);
	setActiveTab('chat');
});

const thread: ChatMessage[] = [
	{ role: 'system', content: 'chat prompt' },
	{ role: 'user', content: 'nginx is 502ing' },
	{ role: 'assistant', content: 'run `systemctl status nginx`' }
];

describe('openShellFromChat', () => {
	it('creates a shell carrying the thread and switches to the Shell tab', () => {
		const session = openShellFromChat({ title: 'nginx 502', messages: thread });
		expect(getShellSessions()).toHaveLength(1);
		expect(getActiveShellId()).toBe(session.id);
		expect(getActiveTab()).toBe('shell');
		expect(session.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
		expect(session.name).toBe('nginx 502');
	});

	it('opens the assistant sidebar so the carried thread is visible on arrival', () => {
		expect(openShellFromChat({ title: 'x', messages: thread }).sidebarOpen).toBe(true);
	});

	it('starts each handoff in its own shell rather than reusing the last', () => {
		const first = openShellFromChat({ title: 'one', messages: thread });
		const second = openShellFromChat({ title: 'two', messages: thread });
		expect(first.id).not.toBe(second.id);
		expect(getShellSessions()).toHaveLength(2);
		expect(getActiveShellId()).toBe(second.id);
	});

	it('still opens a usable shell for a conversation with nothing to carry', () => {
		const session = openShellFromChat({ title: '', messages: [] });
		expect(session.messages).toEqual([]);
		expect(session.sidebarOpen).toBe(true);
		expect(session.name).toMatch(/^Shell \d+$/);
		expect(getActiveTab()).toBe('shell');
	});
});
