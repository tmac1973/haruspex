import { describe, expect, it } from 'vitest';
import { isDetachedRoute, rendersAgentModals } from './windowRoutes';

describe('window routes', () => {
	it('treats detached Shell, Code and editor windows as detached', () => {
		for (const id of ['/shell/[id]', '/code/[id]', '/editor'])
			expect(isDetachedRoute(id)).toBe(true);
		for (const id of ['/', '/settings', null]) expect(isDetachedRoute(id)).toBe(false);
	});

	it('shows approval modals in detached Shell and Code windows, not editors', () => {
		expect(rendersAgentModals('/shell/[id]')).toBe(true);
		expect(rendersAgentModals('/code/[id]')).toBe(true);
		expect(rendersAgentModals('/editor')).toBe(false);
	});
});
