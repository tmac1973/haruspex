import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

export default ts.config(
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node
			}
		},
		rules: {
			complexity: ['warn', 15],
			'max-depth': ['warn', 4],
			'max-lines-per-function': [
				'warn',
				{ max: 80, skipBlankLines: true, skipComments: true }
			],
			'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }]
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser
			}
		},
		rules: {
			// $state() runes require `let` even though the variable is never reassigned
			'prefer-const': 'off',
			// We use {@html} for rendering trusted markdown output
			'svelte/no-at-html-tags': 'off',
			// We use simple goto() navigation without the resolve pattern
			'svelte/no-navigation-without-resolve': 'off'
		}
	},
	{
		// Svelte component files combine script + markup + style; the
		// `max-lines` threshold targeted at TS modules doesn't translate.
		files: ['**/*.svelte'],
		rules: {
			'max-lines': 'off'
		}
	},
	{
		// Test files: `describe`/`it` callbacks are naturally long and the
		// length-per-function rule isn't a useful signal there.
		files: ['**/*.test.ts', '**/*.test.js'],
		rules: {
			'max-lines-per-function': 'off'
		}
	},
	{
		ignores: [
			'build/',
			'.svelte-kit/',
			'dist/',
			'node_modules/',
			'src-tauri/'
		]
	}
);
