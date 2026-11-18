import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import CodePane from '#lib/components/code/CodePane.svelte';
import CodeTabStrip from '#lib/components/code/CodeTabStrip.svelte';
import { registerOpenView, unregisterOpenView } from '#lib/stores/code.svelte.ts';
import {
	ALL_CAPABILITIES,
	type CodeSessionCapabilities,
	type CodeSessionView
} from './sessionView.ts';

const NONE: CodeSessionCapabilities = {
	git: false,
	helpers: false,
	specialists: false,
	detachWindow: false,
	openInShell: false,
	openInEditor: false,
	localFiles: false
};

/**
 * A session the pane can't do everything with, as another computer's is:
 * only what every view has, none of the optional members.
 */
function bareView(over: Partial<CodeSessionView> = {}): CodeSessionView {
	return {
		capabilities: NONE,
		id: 'desk:s1',
		title: 'Fix the build',
		root: '/home/tim/app',
		wslDistro: null,
		status: 'waiting-shell',
		busy: true,
		readOnly: false,
		projectRoot: null,
		messages: [
			{ role: 'user', content: 'Run the tests' },
			{ role: 'assistant', content: 'See `src/main.ts`.' }
		],
		messageSteps: {},
		messageStats: {},
		messageStops: {},
		searchSteps: [],
		streamingContent: '',
		roundText: '',
		steering: [],
		steeringDelivered: [],
		returnedSteering: [],
		returnedImages: [],
		prefill: null,
		pendingToolCalls: [],
		lastError: null,
		saveError: null,
		folderMissing: true,
		compaction: null,
		compacting: false,
		contextNotice: null,
		usage: null,
		totals: { promptTokens: 0, completionTokens: 0, calls: 0 },
		background: [],
		shellWait: { shellName: 'Shell 1' },
		effort: null,
		backend: null,
		fileNotes: [],
		ticket: null,
		send: vi.fn(async () => true),
		stop: vi.fn(),
		continueTurn: vi.fn(async () => {}),
		compactNow: vi.fn(async () => 'nothing'),
		cancelShellWait: vi.fn(),
		stopSubtask: vi.fn(),
		setEffort: vi.fn(async () => {}),
		setBackend: vi.fn(async () => {}),
		takePrefill: () => null,
		takeReturnedSteering: () => [],
		takeReturnedImages: () => [],
		setDraftReader: () => () => {},
		refreshBackground: vi.fn(async () => {}),
		checkFolder: vi.fn(async () => true),
		removeSteering: vi.fn(),
		...over
	} as unknown as CodeSessionView;
}

describe('a Code session without every capability', () => {
	it('renders without the controls it lacks, and without the optional members', () => {
		render(CodePane, { session: bareView() });
		screen.getByText('Run the tests');
		// No branch control or extras (git, helpers, specialists).
		expect(screen.queryByRole('button', { name: /^Branch / })).toBeNull();
		expect(screen.queryByTitle(/Specialists and helpers/)).toBeNull();
		// No Shell to go to, and no folder to choose here.
		screen.getByText(/Waiting for you in Shell 1/);
		expect(screen.queryByRole('button', { name: 'Go to shell' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Choose folder…' })).toBeNull();
		// A path in an answer isn't a link to this computer's editor.
		expect(document.querySelector('[data-action="code-path"]')).toBeNull();
	});

	it('shows those controls when it has the capabilities', () => {
		render(CodePane, {
			session: bareView({
				capabilities: ALL_CAPABILITIES,
				goToShell: vi.fn(),
				moveTo: vi.fn(async () => {}),
				helpers: null,
				specialists: null
			})
		});
		screen.getByRole('button', { name: 'Go to shell' });
		screen.getByRole('button', { name: 'Choose folder…' });
		screen.getByTitle(/Specialists and helpers/);
	});

	it('names the computer it runs on, and says when that computer is offline', () => {
		render(CodePane, {
			session: bareView({
				peer: { id: 'desk', name: 'desk-pc' },
				blockedReason: 'desk-pc is offline.',
				busy: false,
				status: 'idle',
				folderMissing: false,
				shellWait: null
			})
		});
		screen.getByText('Runs on desk-pc');
		const box = screen.getByRole('textbox') as HTMLTextAreaElement;
		expect(box.disabled).toBe(true);
		expect(box.placeholder).toBe('desk-pc is offline.');
	});

	it('has no Detach on its tab, and joins the tabs beside local sessions', () => {
		registerOpenView(
			bareView({ status: 'idle', busy: false, peer: { id: 'desk', name: 'desk-pc' } })
		);
		render(CodeTabStrip, { onNew: () => {} });
		const tab = screen.getByRole('tab', { name: /Fix the build/ });
		// Named in its tooltip; no colour, which would read as the active tab.
		expect(tab.getAttribute('title')).toContain('on desk-pc');
		expect(tab.getAttribute('style')).toBeNull();
		expect(screen.queryByRole('button', { name: /^Detach / })).toBeNull();
		screen.getByRole('button', { name: 'Close Fix the build' });
		unregisterOpenView('desk:s1');
	});
});
