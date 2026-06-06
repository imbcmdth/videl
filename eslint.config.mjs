/**
 * ESLint flat config — video.js style guide adapted for TypeScript.
 *
 * Rule sources:
 *   https://github.com/videojs/eslint-config-videojs
 *   https://typescript-eslint.io/rules/
 *
 * Key style decisions inherited from video.js:
 *   - 2-space indent
 *   - Single quotes
 *   - Semicolons required
 *   - No trailing commas
 *   - 1tbs brace style, always use curly braces
 *   - camelCase identifiers, PascalCase for types/classes
 *   - no-var; prefer-const
 *   - object shorthand
 *   - one declaration per statement
 */

import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  // ── Ignore patterns ────────────────────────────────────────────────────────
  {
    ignores: ['dist/**', 'demo/dist/**', 'node_modules/**'],
  },

  // ── Source files ───────────────────────────────────────────────────────────
  {
    files: ['src/**/*.ts'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // ── Formatting ──────────────────────────────────────────────────────────
      'indent': ['error', 2, {
        SwitchCase: 1,
        flatTernaryExpressions: false,
      }],
      'quotes': ['error', 'single', { avoidEscape: true }],
      'semi': ['error', 'always'],
      'semi-spacing': ['error', { before: false, after: true }],
      'comma-dangle': ['error', 'never'],
      'comma-spacing': ['error', { before: false, after: true }],
      'comma-style': ['error', 'last'],
      'brace-style': ['error', '1tbs', { allowSingleLine: false }],
      'curly': ['error', 'all'],
      'eol-last': 'error',
      'no-trailing-spaces': 'error',
      'no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0 }],
      'space-before-blocks': ['error', 'always'],
      'space-before-function-paren': ['error', { anonymous: 'never', named: 'never', asyncArrow: 'always' }],
      'space-in-parens': ['error', 'never'],
      'space-infix-ops': 'error',
      'space-unary-ops': ['error', { words: true, nonwords: false }],
      'keyword-spacing': ['error', { before: true, after: true }],
      'key-spacing': ['error', { beforeColon: false, afterColon: true }],
      'object-curly-newline': ['error', { consistent: true }],
      'array-bracket-newline': ['error', 'consistent'],
      'function-paren-newline': ['error', 'multiline'],
      'operator-linebreak': ['error', 'after'],
      'spaced-comment': ['error', 'always'],

      // ── Variables & declarations ────────────────────────────────────────────
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all', ignoreReadBeforeAssign: true }],
      'one-var': ['error', 'never'],

      // ── Spacing & operators ─────────────────────────────────────────────────
      'eqeqeq': ['error', 'smart'],
      'dot-notation': 'error',
      'no-floating-decimal': 'error',
      'no-extra-boolean-cast': 'error',

      // ── Objects & syntax ────────────────────────────────────────────────────
      'object-shorthand': ['error', 'always'],
      'new-cap': ['error', { newIsCap: true, capIsNew: false }],
      'new-parens': 'error',

      // ── Error-prone patterns ────────────────────────────────────────────────
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-extend-native': 'error',
      'no-extra-bind': 'error',
      'no-lone-blocks': 'error',
      'no-lonely-if': 'error',
      'no-new-wrappers': 'error',
      'no-return-assign': 'error',
      'no-throw-literal': 'error',
      'no-sequences': 'error',
      'no-self-compare': 'warn',
      'no-nested-ternary': 'warn',
      'no-else-return': 'error',
      'no-alert': 'error',
      'no-console': 'warn',

      // ── Warnings for common slips ───────────────────────────────────────────
      'no-warning-comments': ['warn', { terms: ['todo', 'fixme', 'xxx'], location: 'start' }],

      // ── TypeScript-specific (replaces JS equivalents) ───────────────────────
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { vars: 'all', args: 'none', ignoreRestSiblings: true }],

      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',

      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': ['error', { functions: false, classes: true, variables: true }],

      'no-array-constructor': 'off',
      '@typescript-eslint/no-array-constructor': 'error',

      'no-extra-semi': 'error',

      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // ── Test files — relaxed subset ────────────────────────────────────────────
  {
    files: ['test/**/*.ts'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-warning-comments': 'off',
    },
  }
);
