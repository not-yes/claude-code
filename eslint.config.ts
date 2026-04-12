import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import nodePlugin from 'eslint-plugin-n';
import customRules from './eslint-custom-rules.cjs';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'react-hooks': reactHooks,
      'custom-rules': customRules,
      n: nodePlugin,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'packages/**',
      'eslint-custom-rules.cjs',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Disable rule-not-found errors for eslint-plugin-n sub-rules
      // that are referenced in disable comments but not explicitly enabled
      'n/no-unsupported-features/node-builtins': 'off',
      'n/no-sync': 'off',
    },
  }
);
