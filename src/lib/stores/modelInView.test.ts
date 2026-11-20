import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BackendOverride } from '#lib/api.ts';
import { getActiveTab } from '#lib/stores/activeTab.svelte.ts';
import { getModelInView, resolveModelInView, setJobModelInView } from './modelInView.svelte.ts';

vi.mock('#lib/stores/activeTab.svelte.ts', () => ({ getActiveTab: vi.fn() }));

const jobModel: BackendOverride = { baseUrl: 'https://openrouter.ai/api', modelId: 'x/y' };

describe('resolveModelInView', () => {
	it('names no model on the Code tab', () => {
		expect(resolveModelInView('code', jobModel)).toEqual({ kind: 'server' });
		expect(resolveModelInView('code', null)).toEqual({ kind: 'server' });
	});

	it('is the selected job model on the Jobs tab', () => {
		expect(resolveModelInView('jobs', jobModel)).toEqual({ kind: 'override', backend: jobModel });
		expect(resolveModelInView('jobs', null)).toEqual({ kind: 'settings' });
	});

	it('is Settings on Chat and the Shell', () => {
		expect(resolveModelInView('chat', jobModel)).toEqual({ kind: 'settings' });
		expect(resolveModelInView('shell', jobModel)).toEqual({ kind: 'settings' });
	});
});

describe('getModelInView', () => {
	beforeEach(() => setJobModelInView(null));

	it('reads the tab and the published job', () => {
		vi.mocked(getActiveTab).mockReturnValue('code');
		expect(getModelInView()).toEqual({ kind: 'server' });

		vi.mocked(getActiveTab).mockReturnValue('jobs');
		expect(getModelInView()).toEqual({ kind: 'settings' });
		setJobModelInView(jobModel);
		expect(getModelInView()).toEqual({ kind: 'override', backend: jobModel });

		vi.mocked(getActiveTab).mockReturnValue('chat');
		expect(getModelInView()).toEqual({ kind: 'settings' });
	});
});
