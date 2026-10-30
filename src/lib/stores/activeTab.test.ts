import { describe, it, expect, vi, beforeEach } from 'vitest';

const lean = vi.hoisted(() => ({ on: false }));

vi.mock('#lib/stores/settings.ts', () => ({
	getLiveSettings: () => ({ leanMode: lean.on })
}));

import { getActiveTab, mainTabs, setActiveTab, visibleTabs } from './activeTab.svelte';

describe('active tab in lean mode', () => {
	beforeEach(() => {
		lean.on = false;
		setActiveTab('chat');
	});

	it('shows every tab with lean mode off', () => {
		expect(visibleTabs()).toEqual(['chat', 'jobs', 'shell', 'code']);
	});

	it('shows Chat and Jobs with lean mode on, and keeps the shortcut order', () => {
		lean.on = true;
		expect(visibleTabs()).toEqual(['chat', 'jobs']);
		expect(mainTabs()).toEqual(['chat', 'jobs', 'shell', 'code']);
	});

	it('lands on Chat when something asks for Code or Shell', () => {
		lean.on = true;
		setActiveTab('code');
		expect(getActiveTab()).toBe('chat');
		setActiveTab('shell');
		expect(getActiveTab()).toBe('chat');
		setActiveTab('jobs');
		expect(getActiveTab()).toBe('jobs');
	});

	it('keeps a request made in lean mode for when it goes off', () => {
		lean.on = true;
		setActiveTab('shell');
		lean.on = false;
		expect(getActiveTab()).toBe('shell');
	});

	it('reads a remembered Shell tab as Chat, and returns to it when lean mode goes off', () => {
		setActiveTab('shell');
		lean.on = true;
		expect(getActiveTab()).toBe('chat');
		lean.on = false;
		expect(getActiveTab()).toBe('shell');
	});
});
