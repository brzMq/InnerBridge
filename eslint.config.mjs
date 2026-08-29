import js from '@eslint/js';

const nodeGlobals = {
  Buffer: 'readonly',
  TextDecoder: 'readonly',
  URL: 'readonly',
  __dirname: 'readonly',
  console: 'readonly',
  module: 'writable',
  process: 'readonly',
  require: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
};

export default [
  js.configs.recommended,
  {
    files: ['electron/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
  },
  {
    files: ['src/**/*.js', 'src/**/*.jsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        alert: 'readonly',
        Blob: 'readonly',
        ClipboardItem: 'readonly',
        console: 'readonly',
        confirm: 'readonly',
        crypto: 'readonly',
        clearTimeout: 'readonly',
        document: 'readonly',
        EventSource: 'readonly',
        fetch: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        React: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
        window: 'readonly',
      },
    },
    rules: {
      // Core ESLint does not understand JSX references without an additional React plugin.
      'no-unused-vars': 'off',
    },
  },
  {
    files: ['test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { fetch: 'readonly' },
    },
  },
  {
    rules: {
      'no-console': 'off',
      'no-control-regex': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-escape': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.js', 'src/**/*.jsx'],
    rules: {
      // Core ESLint does not mark identifiers used only by JSX as referenced.
      'no-unused-vars': 'off',
    },
  },
  {
    ignores: ['node_modules/**', 'dist/**', 'release/**', 'build/**', '*.config.js', '*.config.mjs'],
  },
];
