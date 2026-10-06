'use strict';

const nodeGlobals = {
  require: 'readonly', module: 'writable', process: 'readonly', console: 'readonly',
  Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', __dirname: 'readonly', fetch: 'readonly',
  URL: 'readonly', AbortController: 'readonly',
};
const browserGlobals = {
  document: 'readonly', window: 'readonly', fetch: 'readonly', localStorage: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', console: 'readonly',
};

module.exports = [
  { ignores: ['node_modules/**', 'data/**'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: nodeGlobals },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: browserGlobals },
  },
];
