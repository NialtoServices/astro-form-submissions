import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/', 'audit/', '**/*.astro'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    // Client/server boundary: src/client/** ships in the browser bundle, so it must never pull in
    // Node builtins or reach back into the server modules that live above it in src/.
    files: ['src/client/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: 'Client code runs in the browser and cannot import Node builtins.'
            },
            {
              // Every server module resolves through the package `#*` subpath map, so denying the whole
              // `#` namespace keeps the browser bundle server-free without a hand-synced list — a new
              // server module is off-limits by default. Relative specifiers are blocked below too, since
              // they bypass the map. The hash is escaped because these patterns are matched with
              // gitignore semantics, where a leading `#` would otherwise mark the line a comment.
              group: ['\\#*', '\\#*/**'],
              message: 'Client code must not import server modules — keep the browser bundle free of server code.'
            },
            {
              group: [
                '../route',
                '../dispatchers/*',
                '../guards/*',
                '../inspectors/*',
                '../enrichers/*',
                '../storage/*',
                '../files/*',
                '../schema',
                '../pipeline',
                '../responses',
                '../errors',
                '../index'
              ],
              message: 'Client code must not import server modules — keep the browser bundle free of server code.'
            }
          ]
        }
      ]
    }
  }
)
