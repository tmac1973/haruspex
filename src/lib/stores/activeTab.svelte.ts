import { persistItem } from '#lib/persist.ts';
import { getLiveSettings } from '#lib/stores/settings.ts';

export type ActiveTab = 'chat' | 'jobs' | 'shell' | 'code';

const STORAGE_KEY = 'haruspex.activeTab';

/** The main tabs in TabBar order, as the Ctrl / ⌘ + digit shortcuts number them. */
export function mainTabs(): ActiveTab[] {
	return ['chat', 'jobs', 'shell', 'code'];
}

/**
 * The tabs the window shows: Chat and Jobs alone in lean mode (Settings →
 * General → Lean mode), all four otherwise. `mainTabs` keeps its fixed
 * order, so Ctrl / ⌘ + 1 and 2 mean the same tab in either.
 */
export function visibleTabs(): ActiveTab[] {
	return getLiveSettings().leanMode ? ['chat', 'jobs'] : mainTabs();
}

function load(): ActiveTab {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === 'chat' || raw === 'jobs' || raw === 'shell' || raw === 'code') return raw;
	} catch {
		// ignore
	}
	return 'chat';
}

let activeTab = $state<ActiveTab>(load());

/**
 * The tab on screen. In lean mode a Code or Shell tab reads as Chat, but
 * stays remembered: turning lean mode off goes back to it.
 */
export function getActiveTab(): ActiveTab {
	return visibleTabs().includes(activeTab) ? activeTab : 'chat';
}

/**
 * Show `tab`. In lean mode a request for Code or Shell (the Tasks chip, open
 * in Shell, a code window coming back) shows Chat through `getActiveTab`,
 * and is kept for when lean mode is turned off.
 */
export function setActiveTab(tab: ActiveTab): void {
	activeTab = tab;
	try {
		persistItem(STORAGE_KEY, tab);
	} catch {
		// ignore
	}
}
