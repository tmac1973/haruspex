import { wslDistros } from '#lib/code/db.ts';
import { nativeWindowsCode } from '#lib/code/native.ts';

export type ActiveTab = 'chat' | 'jobs' | 'shell' | 'code';

const STORAGE_KEY = 'haruspex.activeTab';

function isWindows(userAgent: string): boolean {
	return /Windows/i.test(userAgent);
}

function currentUserAgent(): string {
	return (typeof navigator !== 'undefined' && navigator.userAgent) || '';
}

/**
 * Windows: whether a WSL2 distro is installed, since the Code tab works
 * inside one there (native folders are #396). Null until `probeCodeTab` answers.
 */
let wslReady = $state<boolean | null>(null);

/**
 * Whether the Code tab is shown. On Windows once `probeCodeTab` has found a
 * WSL2 distro (false while it hasn't answered), or always where sessions in
 * native folders are on (`nativeWindowsCode`); elsewhere always.
 */
export function codeTabAvailable(userAgent = currentUserAgent()): boolean {
	if (!isWindows(userAgent)) return true;
	return nativeWindowsCode() || wslReady === true;
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
			codeWaiting = isWindows(currentUserAgent());
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
	if (!isWindows(userAgent) || wslReady !== null) return;
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
