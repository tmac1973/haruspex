/**
 * Which highlighter a file gets: CodeMirror's language list, matched by file
 * name or extension. Markdown is in the editor chunk; every other language
 * is its own chunk, loaded the first time a file of that kind opens.
 */
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { markdown } from '@codemirror/lang-markdown';

/** Markdown, with fenced code highlighted in the language the fence names. */
export const markdownWithCode = () => markdown({ codeLanguages: languages });

/** Files the list doesn't know, read with the parser that fits them best. */
const ALIASES: Record<string, string> = { svelte: 'html' };

/**
 * The language for `path`: 'markdown', one to load, or null for plain text.
 * No path means markdown we wrote ourselves (a skill, AGENTS.md).
 */
export function languageFor(path?: string): 'markdown' | LanguageDescription | null {
	if (path === undefined) return 'markdown';
	const name = path.split(/[\\/]/).pop() ?? '';
	const ext = /\.([^.]+)$/.exec(name)?.[1].toLowerCase();
	const alias = ext && ALIASES[ext];
	const found = alias
		? LanguageDescription.matchLanguageName(languages, alias, false)
		: (LanguageDescription.matchFilename(languages, name) ??
			LanguageDescription.matchFilename(languages, name.toLowerCase()));
	if (!found) return null;
	return found.name === 'Markdown' ? 'markdown' : found;
}
