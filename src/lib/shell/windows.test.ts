import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: vi.fn() }));
vi.mock('#lib/stores/shell.svelte.ts', () => ({
	detachShellSession: vi.fn(),
	reattachShellSession: vi.fn()
}));
vi.mock('#lib/appWindow.ts', () => ({ openAppWindow: vi.fn(async () => {}) }));
vi.mock('#lib/stores/settings.ts', () => ({ getSettings: () => ({ shellSidebarWidth: 340.4 }) }));

import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { openAppWindow } from '#lib/appWindow.ts';
import { detachShellSession, reattachShellSession } from '#lib/stores/shell.svelte.ts';
import type { ShellSession } from '#lib/stores/shell.svelte.ts';
import {
	detachedShellUrl,
	fullAccessFromUrl,
	handBackToMain,
	listenForReattach,
	openDetachedShell
} from './windows.ts';

function session(over: Partial<ShellSession> = {}): ShellSession {
	return {
		id: 'tab-1',
		name: 'build box',
		boundSessionId: 42,
		fullAccess: true,
		serializeChat: () => '{"messages":[]}',
		serializeTerminal: () => 'scrollback',
		...over
	} as unknown as ShellSession;
}

const commands = () => vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	vi.mocked(openAppWindow).mockReset();
	vi.mocked(detachShellSession).mockReset();
	vi.mocked(reattachShellSession).mockReset();
	vi.mocked(emit).mockReset();
});

describe('detached shell windows', () => {
	it('carry Full access to the new window, and Read-only by default', () => {
		const full = new URL(detachedShellUrl(3, true), 'http://localhost');
		expect(full.pathname).toBe('/shell/3');
		expect(fullAccessFromUrl(full)).toBe(true);

		const readOnly = new URL(detachedShellUrl(3, false), 'http://localhost');
		expect(readOnly.pathname).toBe('/shell/3');
		expect(fullAccessFromUrl(readOnly)).toBe(false);
	});
});

describe('openDetachedShell', () => {
	it('stashes the chat and scrollback, opens the window, then drops the tab here', async () => {
		await openDetachedShell(session());
		expect(invoke).toHaveBeenCalledWith('shell_stash_chat', {
			sessionId: 42,
			chat: '{"messages":[]}'
		});
		expect(invoke).toHaveBeenCalledWith('shell_stash_scrollback', {
			sessionId: 42,
			data: 'scrollback'
		});
		expect(openAppWindow).toHaveBeenCalledWith({
			label: 'shell-42',
			url: '/shell/42?access=full',
			title: 'build box',
			// The terminal's width beside the saved sidebar's, rounded.
			width: 760 + 340,
			height: 700
		});
		expect(detachShellSession).toHaveBeenCalledWith('tab-1');
	});

	it('does nothing before the terminal has a PTY', async () => {
		await openDetachedShell(session({ boundSessionId: null }));
		expect(invoke).not.toHaveBeenCalled();
		expect(openAppWindow).not.toHaveBeenCalled();
	});

	it('keeps the tab when the window does not open', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(openAppWindow).mockRejectedValueOnce(new Error('no window'));
		await openDetachedShell(session());
		expect(detachShellSession).not.toHaveBeenCalled();
		error.mockRestore();
	});

	it('still opens the window when a stash fails', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(invoke).mockRejectedValue(new Error('stash full'));
		await openDetachedShell(session());
		expect(openAppWindow).toHaveBeenCalled();
		expect(detachShellSession).toHaveBeenCalled();
		error.mockRestore();
	});
});

describe('handing a shell back', () => {
	it('stashes the window’s state, then tells the main window', async () => {
		await handBackToMain(42, '{"m":1}', 'build box', 'grid', false);
		expect(commands()).toEqual(['shell_stash_chat', 'shell_stash_scrollback']);
		expect(emit).toHaveBeenCalledWith('shell://reattach', {
			ptyId: 42,
			name: 'build box',
			fullAccess: false
		});
	});

	it('re-attaches what a window hands back, in the mode it had', async () => {
		let handler: (e: { payload: unknown }) => void = () => {};
		vi.mocked(listen).mockImplementation(async (_event, h) => {
			handler = h as typeof handler;
			return () => {};
		});
		await listenForReattach();
		expect(listen).toHaveBeenCalledWith('shell://reattach', expect.any(Function));
		handler({ payload: { ptyId: 42, name: 'build box', fullAccess: true } });
		expect(reattachShellSession).toHaveBeenCalledWith(42, 'build box', true);
		// An older window sends no mode: the main window keeps its own.
		handler({ payload: { ptyId: 7 } });
		expect(reattachShellSession).toHaveBeenLastCalledWith(7, undefined, null);
	});
});
