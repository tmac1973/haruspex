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
			'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
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
		// Test files: `describe`/`it` callbacks are naturally long, and a file
		// grows with every case its source needs; neither length rule is a
		// useful signal there.
		files: ['**/*.test.ts', '**/*.test.js'],
		rules: {
			'max-lines-per-function': 'off',
			'max-lines': 'off'
		}
	},
	{
		// App code logs through console.warn / console.error only: those reach
		// devtools and, via forwardConsoleToDebugLog, the debug log a user can
		// attach. console.log / info / debug would reach devtools alone.
		files: ['src/**/*.ts', 'src/**/*.svelte'],
		ignores: ['**/*.test.ts'],
		rules: {
			'no-console': ['error', { allow: ['warn', 'error'] }]
		}
	},
	{
		// src/lib imports go through `#lib/<path>` with the file's extension
		// (CLAUDE.md): an extensionless relative path is how `./loop` ends up
		// meaning loop.ts in one place and loop/ in another.
		files: ['src/lib/**/*.ts', 'src/lib/**/*.svelte'],
		ignores: ['**/*.test.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							regex: '^\\.{1,2}/',
							message: "Import from src/lib as '#lib/<path>' with the file's extension."
						}
					]
				}
			]
		}
	},
	{
		// A promise nobody awaits, voids or catches turns a failure into an
		// unhandled rejection: say `void` when the callee handles its own
		// errors, `void … .catch` when it doesn't. Needs type information, so
		// only this rule runs typed. no-floating-promises counts a bare
		// `.catch(…)` statement as handled, so the second rule asks for the
		// `void` there too: it marks the call as fire-and-forget at a glance.
		files: ['src/**/*.ts', 'src/**/*.svelte'],
		ignores: ['**/*.test.ts'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			'@typescript-eslint/no-floating-promises': 'error',
			'no-restricted-syntax': [
				'error',
				{
					selector: "ExpressionStatement > CallExpression[callee.property.name='catch']",
					message: 'Mark a fire-and-forget promise with `void`, even with a `.catch`.'
				}
			]
		}
	},
	{
		ignores: ['build/', '.svelte-kit/', 'dist/', 'node_modules/', 'src-tauri/', 'src/lib/ipc/gen/']
	}
);
