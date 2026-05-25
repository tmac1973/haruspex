export type ActiveTab = 'chat' | 'workspace' | 'jobs';

const STORAGE_KEY = 'haruspex.activeTab';

function load(): ActiveTab {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === 'chat' || raw === 'workspace' || raw === 'jobs') return raw;
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
	activeTab = tab;
	try {
		localStorage.setItem(STORAGE_KEY, tab);
	} catch {
		// ignore
	}
}
