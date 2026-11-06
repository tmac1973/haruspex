import { persistItem } from '#lib/persist.ts';
import { getLiveSettings } from '#lib/stores/settings.ts';

export type ActiveTab = 'home' | 'chat' | 'jobs' | 'shell' | 'code';

const STORAGE_KEY = 'haruspex.activeTab';

/** The main tabs in TabBar order, as the Ctrl / ⌘ + digit shortcuts number them. */
export function mainTabs(): ActiveTab[] {
	return ['home', 'chat', 'jobs', 'shell', 'code'];
}

/**
 * The tabs the window shows: Chat and Jobs alone in lean mode (Settings →
 * General → Lean mode), all five otherwise, less Home when Settings →
 * General → Home tab is off. `mainTabs` keeps its fixed order, so
 * Ctrl / ⌘ + 2 and 3 mean the same tab in each.
 */
export function visibleTabs(): ActiveTab[] {
	const s = getLiveSettings();
	if (s.leanMode) return ['chat', 'jobs'];
	return s.homeTab ? mainTabs() : mainTabs().filter((t) => t !== 'home');
}

function load(): ActiveTab {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (mainTabs().includes(raw as ActiveTab)) return raw as ActiveTab;
	} catch {
		// ignore
	}
	return 'chat';
}

let activeTab = $state<ActiveTab>(load());

/**
 * The tab on screen. A hidden tab (Home, Code or Shell in lean mode, Home
 * with the Home tab off) reads as Chat, but stays remembered: showing it
 * again goes back to it.
 */
export function getActiveTab(): ActiveTab {
	return visibleTabs().includes(activeTab) ? activeTab : 'chat';
}

/**
 * Show `tab`. In lean mode a request for Home, Code or Shell (the Tasks chip, open
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
