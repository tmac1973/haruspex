/**
 * CodeMirror 6, set up the way Haruspex uses it: markdown, the app's own
 * colours, nothing that reaches the network.
 *
 * Imported only through a dynamic `import()` from `CodeEditor.svelte`, so its
 * ~200 KB loads the first time an editor opens rather than at app start.
 */
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

export interface EditorHandle {
	getValue(): string;
	setValue(value: string): void;
	focus(): void;
	destroy(): void;
}

export interface EditorOptions {
	doc: string;
	readonly?: boolean;
	onChange?: (value: string) => void;
	/** Ctrl/Cmd-S. */
	onSave?: () => void;
}

/**
 * The app's theme tokens, so the editor follows light and dark mode with the
 * rest of the UI instead of shipping a theme of its own.
 */
const theme = EditorView.theme({
	'&': {
		height: '100%',
		backgroundColor: 'var(--bg-primary)',
		color: 'var(--text-primary)',
		fontSize: '0.9rem'
	},
	'.cm-scroller': {
		fontFamily: "ui-monospace, Menlo, Monaco, 'Cascadia Mono', monospace",
		lineHeight: '1.55'
	},
	'.cm-content': { caretColor: 'var(--text-primary)' },
	'.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text-primary)' },
	'.cm-gutters': {
		backgroundColor: 'var(--bg-secondary)',
		color: 'var(--text-secondary)',
		border: 'none',
		borderRight: '1px solid var(--border)'
	},
	'.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 6%, transparent)' },
	'.cm-activeLineGutter': {
		backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)'
	},
	'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
		backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)'
	},
	'.cm-panels': { backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' },
	'&.cm-focused': { outline: 'none' }
});

/** Markdown highlighting in the same tokens, readable in both themes. */
const highlight = HighlightStyle.define([
	{ tag: tags.heading, fontWeight: '700', color: 'var(--accent)' },
	{ tag: tags.strong, fontWeight: '700' },
	{ tag: tags.emphasis, fontStyle: 'italic' },
	{ tag: tags.strikethrough, textDecoration: 'line-through' },
	{ tag: [tags.link, tags.url], color: 'var(--accent)', textDecoration: 'underline' },
	{ tag: tags.monospace, color: 'var(--accent)' },
	{ tag: [tags.processingInstruction, tags.contentSeparator], color: 'var(--text-secondary)' },
	{ tag: tags.quote, color: 'var(--text-secondary)', fontStyle: 'italic' },
	{ tag: [tags.keyword, tags.operator], color: 'var(--accent)' },
	{ tag: [tags.string, tags.number], color: 'var(--text-secondary)' },
	{ tag: tags.comment, color: 'var(--text-secondary)', fontStyle: 'italic' }
]);

export function createEditor(parent: HTMLElement, options: EditorOptions): EditorHandle {
	const view = new EditorView({
		parent,
		state: EditorState.create({
			doc: options.doc,
			extensions: [
				basicSetup,
				markdown(),
				theme,
				syntaxHighlighting(highlight),
				EditorView.lineWrapping,
				EditorState.readOnly.of(!!options.readonly),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) options.onChange?.(update.state.doc.toString());
				}),
				EditorView.domEventHandlers({
					keydown(event) {
						if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
							event.preventDefault();
							options.onSave?.();
							return true;
						}
						return false;
					}
				})
			]
		})
	});
	return {
		getValue: () => view.state.doc.toString(),
		setValue(value) {
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
		},
		focus: () => view.focus(),
		destroy: () => view.destroy()
	};
}
