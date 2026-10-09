// ESLint flat config for the mods' TypeScript.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules/**', '**/.claude-plugin/types/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['mods/**/*.{ts,tsx}', 'shared/**/*.ts'],
    rules: {
      // Unused imports are unused variables: this rule reports both.
      '@typescript-eslint/no-unused-vars': 'error',
      'no-unreachable': 'error',
    },
  },
)
