/**
 * Custom ESLint rules placeholder plugin
 *
 * This plugin provides stub definitions for custom rules referenced
 * throughout the codebase via eslint-disable comments. The actual rule
 * implementations are not present, so we create no-op rules to prevent
 * "Definition for rule was not found" errors.
 */

function createNoOpRule() {
  return {
    meta: {
      type: 'problem',
      docs: {
        description: 'No-op placeholder for missing custom rule',
      },
      schema: [],
    },
    create() {
      return {};
    },
  };
}

module.exports = {
  rules: {
    'bootstrap-isolation': createNoOpRule(),
    'no-process-exit': createNoOpRule(),
    'prefer-use-terminal-size': createNoOpRule(),
    'prefer-use-keybindings': createNoOpRule(),
    'no-sync-fs': createNoOpRule(),
    'no-process-env-top-level': createNoOpRule(),
    'no-top-level-side-effects': createNoOpRule(),
    'no-direct-json-operations': createNoOpRule(),
    'no-lookbehind-regex': createNoOpRule(),
    'no-cross-platform-process-issues': createNoOpRule(),
    'require-bun-typeof-guard': createNoOpRule(),
    'no-process-cwd': createNoOpRule(),
  },
};
