/**
 * Whether the Settings overlay is open, and where a caller asked it to open.
 * A store rather than the layout's own state so anything can open Settings
 * at the setting it means: the header's Lean mode badge opens Settings →
 * General at the lean mode switch.
 */
import type { Category } from '#lib/components/settings/categories.ts';

interface SettingsNav {
	open: boolean;
	/** The section to show, until the panel has shown it. */
	category: Category | null;
	/** The element id to scroll to in that section, likewise. */
	anchor: string | null;
}

const nav = $state<SettingsNav>({ open: false, category: null, anchor: null });

export function getSettingsNav(): Readonly<SettingsNav> {
	return nav;
}

/** Open Settings, at `category` and scrolled to `anchor` when given. */
export function openSettings(category?: Category, anchor?: string): void {
	nav.open = true;
	nav.category = category ?? null;
	nav.anchor = anchor ?? null;
}

export function closeSettings(): void {
	nav.open = false;
	nav.category = null;
	nav.anchor = null;
}

export function toggleSettings(): void {
	if (nav.open) closeSettings();
	else openSettings();
}

/** The panel has shown the requested section; a later open asks afresh. */
export function settingsNavHandled(): void {
	nav.category = null;
	nav.anchor = null;
}
