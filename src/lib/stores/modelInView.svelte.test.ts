import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BackendOverride } from '#lib/api.ts';
import { getActiveTab } from '#lib/stores/activeTab.svelte.ts';
import { getActiveSession, type CodeSession } from '#lib/stores/code.svelte.ts';
import { getModelInView, resolveModelInView, setJobModelInView } from './modelInView.svelte.ts';

vi.mock('#lib/stores/activeTab.svelte.ts', () => ({ getActiveTab: vi.fn() }));
vi.mock('#lib/stores/code.svelte.ts', () => ({ getActiveSession: vi.fn() }));

const sessionModel: BackendOverride = { baseUrl: 'http://gpu-box:8080', modelId: 'big' };
const jobModel: BackendOverride = { baseUrl: 'https://openrouter.ai/api', modelId: 'x/y' };

describe('resolveModelInView', () => {
	it('is the Code session model on the Code tab', () => {
		expect(resolveModelInView('code', sessionModel, jobModel)).toEqual({
			kind: 'override',
			backend: sessionModel,
			source: 'code'
		});
		expect(resolveModelInView('code', null, jobModel)).toEqual({ kind: 'settings' });
	});

	it('is the selected job model on the Jobs tab', () => {
		expect(resolveModelInView('jobs', sessionModel, jobModel)).toEqual({
			kind: 'override',
			backend: jobModel,
			source: 'job'
		});
		expect(resolveModelInView('jobs', sessionModel, null)).toEqual({ kind: 'settings' });
	});

	it('is Settings on Chat and the Shell', () => {
		expect(resolveModelInView('chat', sessionModel, jobModel)).toEqual({ kind: 'settings' });
		expect(resolveModelInView('shell', sessionModel, jobModel)).toEqual({ kind: 'settings' });
	});
});

describe('getModelInView', () => {
	beforeEach(() => setJobModelInView(null));

	it('reads the active session and the published job', () => {
		vi.mocked(getActiveSession).mockReturnValue({ backend: sessionModel } as CodeSession);
		vi.mocked(getActiveTab).mockReturnValue('code');
		expect(getModelInView()).toMatchObject({ source: 'code', backend: sessionModel });

		vi.mocked(getActiveTab).mockReturnValue('jobs');
		expect(getModelInView()).toEqual({ kind: 'settings' });
		setJobModelInView(jobModel);
		expect(getModelInView()).toMatchObject({ source: 'job', backend: jobModel });

		vi.mocked(getActiveTab).mockReturnValue('chat');
		expect(getModelInView()).toEqual({ kind: 'settings' });
	});

	it('follows Settings when no Code session is open', () => {
		vi.mocked(getActiveSession).mockReturnValue(null);
		vi.mocked(getActiveTab).mockReturnValue('code');
		expect(getModelInView()).toEqual({ kind: 'settings' });
	});
});
