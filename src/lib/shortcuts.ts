/**
 * The app's keyboard shortcuts, as the help window (F1) lists them. The
 * single source of truth: when a binding changes, change it here, and the
 * user guide's `shortcuts` page, which a test holds to this list
 * (src/lib/guide/pages.test.ts).
 */

export interface Shortcut {
	keys: string;
	action: string;
}
export interface ShortcutSection {
	title: string;
	items: Shortcut[];
}

export const SHORTCUTS: ShortcutSection[] = [
	{
		title: 'Global',
		items: [
			{ keys: 'F1', action: 'Show this shortcuts help' },
			{ keys: 'F2 (hold)', action: 'Push-to-talk — voice input, release to send' },
			{ keys: 'F3', action: 'Read the last reply aloud (toggle)' },
			{ keys: 'Ctrl / ⌘ + N', action: 'New conversation (Chat tab)' },
			{ keys: 'Ctrl / ⌘ + + / −', action: 'Zoom the UI in / out' },
			{ keys: 'Ctrl / ⌘ + 0', action: 'Reset UI zoom' },
			{ keys: 'Ctrl + Shift + I / ⌘ + ⌥ + I', action: 'Open the web inspector (devtools)' }
		]
	},
	{
		title: 'Chat',
		items: [
			{ keys: 'Enter', action: 'Send message' },
			{ keys: 'Shift + Enter', action: 'New line' },
			{ keys: 'Esc', action: 'Stop generating' }
		]
	},
	{
		title: 'Shell tab',
		items: [
			{
				keys: 'F4',
				action: 'Submit recent shell commands & output to the assistant (no prompt)'
			},
			{ keys: 'Ctrl + Shift + A', action: 'Toggle the assistant sidebar' },
			{ keys: 'Ctrl + `', action: 'Switch focus: terminal ↔ assistant' },
			{ keys: 'Ctrl + Shift + C', action: 'Copy terminal selection' },
			{ keys: 'Ctrl + Shift + V', action: 'Paste into terminal' },
			{ keys: 'Enter', action: 'Send to assistant (Shift + Enter for new line)' },
			{ keys: 'Esc', action: 'Stop the assistant' }
		]
	},
	{
		title: 'Dialogs',
		items: [{ keys: 'Esc', action: 'Close logs, the image viewer, or this help' }]
	}
];
