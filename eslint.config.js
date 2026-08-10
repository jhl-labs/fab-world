import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'data/layouts/fab-default.json'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', fetch: 'readonly', setTimeout: 'readonly', console: 'readonly' } }
  },
  {
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [{ name: 'three', message: 'Simulation must remain Three.js-free.' }] }]
    }
  },
  {
    files: ['src/render/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['../sim/**', '../../sim/**'], message: 'Renderer communicates with simulation through core/protocol only.' }] }]
    }
  }
)
