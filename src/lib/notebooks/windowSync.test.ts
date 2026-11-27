import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	label: 'main',
	emitTo: vi.fn(async () => {}),
	listen: vi.fn(async () => () => {})
}));

vi.mock('@tauri-apps/api/event', () => ({ emitTo: mocks.emitTo, listen: mocks.listen }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({ label: mocks.label })
}));

import { forwardToMain, listenForNotebookChanges, NOTEBOOK_CHANGED_EVENT } from './windowSync';

beforeEach(() => {
	mocks.emitTo.mockClear();
	mocks.listen.mockClear();
});

describe('notebook changes across windows', () => {
	it('a detached window passes its change to the main window', () => {
		mocks.label = 'shell-7';
		forwardToMain({ notebookId: 'nb', cardIds: ['c1'] });
		expect(mocks.emitTo).toHaveBeenCalledWith('main', NOTEBOOK_CHANGED_EVENT, {
			notebookId: 'nb',
			cardIds: ['c1']
		});
	});

	it('the main window keeps its own changes to itself', () => {
		mocks.label = 'main';
		forwardToMain({ notebookId: 'nb', cardIds: [] });
		expect(mocks.emitTo).not.toHaveBeenCalled();
	});

	it('the main window applies what others pass on', async () => {
		const apply = vi.fn();
		await listenForNotebookChanges(apply);
		const [event, handler] = mocks.listen.mock.calls[0] as unknown as [
			string,
			(e: { payload: unknown }) => void
		];
		expect(event).toBe(NOTEBOOK_CHANGED_EVENT);
		handler({ payload: { notebookId: 'nb', cardIds: ['c2'] } });
		expect(apply).toHaveBeenCalledWith({ notebookId: 'nb', cardIds: ['c2'] });
	});
});
