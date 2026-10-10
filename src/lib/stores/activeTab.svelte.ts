import { wslDistros } from '#lib/code/db.ts';

export type ActiveTab = 'chat' | 'jobs' | 'shell' | 'code';

const STORAGE_KEY = 'haruspex.activeTab';

/**
 * On Windows the Code tab works in WSL2 distros only, and is behind this flag
 * until it runs there end to end (plan/code-tab/phase-10-windows-wsl.md,
 * milestone 5): dev builds show it, releases don't.
 */
const WSL_CODE_TAB = import.meta.env.DEV;

function isWindows(userAgent: string): boolean {
	return /Windows/i.test(userAgent);
}

function currentUserAgent(): string {
	return (typeof navigator !== 'undefined' && navigator.userAgent) || '';
}

/** Windows: whether a WSL2 distro is installed. Null until `probeCodeTab` answers. */
let wslReady = $state<boolean | null>(null);

/**
 * Whether the Code tab is shown. On Windows only once `probeCodeTab` has found
 * a WSL2 distro (false while it hasn't answered); elsewhere always.
 */
export function codeTabAvailable(userAgent = currentUserAgent()): boolean {
	if (!isWindows(userAgent)) return true;
	return WSL_CODE_TAB && wslReady === true;
}

/** The main tabs in TabBar order, as the Ctrl / ⌘ + digit shortcuts number them. */
export function mainTabs(): ActiveTab[] {
	return codeTabAvailable() ? ['chat', 'jobs', 'shell', 'code'] : ['chat', 'jobs', 'shell'];
}

/** The Code tab was the last one open, and the probe hasn't said yet whether it exists. */
let codeWaiting = false;

function load(): ActiveTab {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === 'chat' || raw === 'jobs' || raw === 'shell') return raw;
		if (raw === 'code') {
			if (codeTabAvailable()) return raw;
			codeWaiting = isWindows(currentUserAgent()) && WSL_CODE_TAB;
		}
	} catch {
		// ignore
	}
	return 'chat';
}

let activeTab = $state<ActiveTab>(load());

/**
 * Find out (once, at startup) whether the Code tab can show on Windows, and
 * reopen it if it was the last tab open. Nothing to do elsewhere.
 */
export async function probeCodeTab(userAgent = currentUserAgent()): Promise<void> {
	if (!isWindows(userAgent) || !WSL_CODE_TAB || wslReady !== null) return;
	wslReady = (await wslDistros()).length > 0;
	if (codeWaiting && wslReady && activeTab === 'chat') activeTab = 'code';
	codeWaiting = false;
}

export function getActiveTab(): ActiveTab {
	return activeTab;
}

export function setActiveTab(tab: ActiveTab): void {
	if (tab === 'code' && !codeTabAvailable()) return;
	codeWaiting = false;
	activeTab = tab;
	try {
		localStorage.setItem(STORAGE_KEY, tab);
	} catch {
		// ignore
	}
}
