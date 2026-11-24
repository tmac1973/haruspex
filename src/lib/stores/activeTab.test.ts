import { describe, it, expect, vi, beforeEach } from 'vitest';

const lean = vi.hoisted(() => ({ on: false, home: true, notebooks: true }));

vi.mock('#lib/stores/settings.ts', () => ({
	getLiveSettings: () => ({
		leanMode: lean.on,
		homeTab: lean.home,
		notebooksTab: lean.notebooks
	})
}));

import { getActiveTab, mainTabs, setActiveTab, visibleTabs } from './activeTab.svelte';

describe('active tab in lean mode', () => {
	beforeEach(() => {
		lean.on = false;
		lean.home = true;
		lean.notebooks = true;
		setActiveTab('chat');
	});

	it('shows every tab with lean mode off', () => {
		expect(visibleTabs()).toEqual(['home', 'chat', 'notebooks', 'jobs', 'shell', 'code']);
	});

	it('shows Chat and Jobs with lean mode on, and keeps the shortcut order', () => {
		lean.on = true;
		expect(visibleTabs()).toEqual(['chat', 'jobs']);
		expect(mainTabs()).toEqual(['home', 'chat', 'notebooks', 'jobs', 'shell', 'code']);
	});

	it('lands on Chat when something asks for Home, Code or Shell', () => {
		lean.on = true;
		setActiveTab('home');
		expect(getActiveTab()).toBe('chat');
		setActiveTab('code');
		expect(getActiveTab()).toBe('chat');
		setActiveTab('shell');
		expect(getActiveTab()).toBe('chat');
		setActiveTab('jobs');
		expect(getActiveTab()).toBe('jobs');
	});

	it('leaves out Home when the Home tab is off, and returns to it when it comes back', () => {
		setActiveTab('home');
		lean.home = false;
		expect(visibleTabs()).toEqual(['chat', 'notebooks', 'jobs', 'shell', 'code']);
		expect(getActiveTab()).toBe('chat');
		lean.home = true;
		expect(getActiveTab()).toBe('home');
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

describe('the Notebooks tab', () => {
	beforeEach(() => {
		lean.on = false;
		lean.home = true;
		lean.notebooks = true;
	});

	it('sits after Chat and goes when its setting is off', () => {
		expect(visibleTabs()).toEqual(['home', 'chat', 'notebooks', 'jobs', 'shell', 'code']);
		setActiveTab('notebooks');
		lean.notebooks = false;
		expect(visibleTabs()).toEqual(['home', 'chat', 'jobs', 'shell', 'code']);
		expect(getActiveTab()).toBe('chat');
		lean.notebooks = true;
		expect(getActiveTab()).toBe('notebooks');
	});

	it('is hidden in lean mode', () => {
		setActiveTab('notebooks');
		lean.on = true;
		expect(getActiveTab()).toBe('chat');
	});
});
