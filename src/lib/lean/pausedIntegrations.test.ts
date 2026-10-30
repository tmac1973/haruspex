import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
	email: false,
	calendar: false,
	contacts: false,
	settings: {} as Record<string, unknown>,
	mcp: [] as { label: string }[]
}));

vi.mock('#lib/stores/settings.ts', () => ({
	getSettings: () => state.settings,
	hasEnabledEmailAccount: () => state.email,
	hasEnabledCalendarAccount: () => state.calendar,
	hasEnabledContactsAccount: () => state.contacts,
	startableMcpServers: () => state.mcp
}));

import { pausedIntegrations } from './pausedIntegrations';

const NOTHING = {
	screenCaptureEnabled: false,
	imageBackendKind: 'none',
	musicBackendKind: 'none',
	videoGenBackendKind: 'none',
	sandboxEnabled: false
};

describe('pausedIntegrations', () => {
	beforeEach(() => {
		Object.assign(state, { email: false, calendar: false, contacts: false, mcp: [] });
		state.settings = { ...NOTHING };
	});

	it('lists nothing when nothing is set up', () => {
		expect(pausedIntegrations()).toEqual([]);
	});

	it('lists each integration that is set up, in Settings order', () => {
		Object.assign(state, { email: true, calendar: true, contacts: true });
		state.settings = {
			screenCaptureEnabled: true,
			imageBackendKind: 'comfyui',
			musicBackendKind: 'toolchest',
			videoGenBackendKind: 'toolchest',
			sandboxEnabled: true
		};
		state.mcp = [{ label: 'GitHub' }, { label: 'Blender' }];
		expect(pausedIntegrations()).toEqual([
			'Email',
			'Calendar',
			'Contacts',
			'Screen capture',
			'Image generation',
			'Music generation',
			'Video generation',
			'Python sandbox',
			'MCP: GitHub',
			'MCP: Blender'
		]);
	});

	it('leaves out what is switched off', () => {
		state.email = true;
		state.settings = { ...NOTHING, sandboxEnabled: true };
		expect(pausedIntegrations()).toEqual(['Email', 'Python sandbox']);
	});
});
