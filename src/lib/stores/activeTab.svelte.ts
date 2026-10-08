export type ActiveTab = 'chat' | 'jobs' | 'shell' | 'code';

const STORAGE_KEY = 'haruspex.activeTab';

/**
 * The Code tab is hidden on Windows until it runs there (WSL first, see
 * plan/code-tab/phase-10-windows-wsl.md).
 */
export function codeTabAvailable(
	userAgent = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
): boolean {
	return !/Windows/i.test(userAgent);
}

/** The main tabs in TabBar order, as the Ctrl / ⌘ + digit shortcuts number them. */
export function mainTabs(): ActiveTab[] {
	return codeTabAvailable() ? ['chat', 'jobs', 'shell', 'code'] : ['chat', 'jobs', 'shell'];
}

function load(): ActiveTab {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === 'chat' || raw === 'jobs' || raw === 'shell') return raw;
		if (raw === 'code' && codeTabAvailable()) return raw;
	} catch {
		// ignore
	}
	return 'chat';
}

let activeTab = $state<ActiveTab>(load());

export function getActiveTab(): ActiveTab {
	return activeTab;
}

export function setActiveTab(tab: ActiveTab): void {
	if (tab === 'code' && !codeTabAvailable()) return;
	activeTab = tab;
	try {
		localStorage.setItem(STORAGE_KEY, tab);
	} catch {
		// ignore
	}
}
