const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2022,
      globals: {
        require: 'readonly', module: 'writable', process: 'readonly',
        console: 'readonly', __dirname: 'readonly', fetch: 'readonly',
      },
    },
  },
  { ignores: ['node_modules/**', 'coverage/**', 'data/**'] },
];