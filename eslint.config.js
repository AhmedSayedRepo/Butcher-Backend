// Flat config for ESLint 9. Replaces eslint-config-standard-with-typescript,
// which was deprecated upstream, hard-pinned a vulnerable minimatch via its
// @typescript-eslint v6 dependency (npm audit: 6 high-severity ReDoS
// findings, dev-tooling only, never reached the running server), and had no
// actual config file wired up in this repo in the first place — see
// ROADMAP.md for the full history.
//
// Scoped to src/**/*.ts only: eslint-config-love sets
// languageOptions.parserOptions.project = true, which auto-discovers the
// nearest tsconfig.json for type-aware linting. tsconfig.json's rootDir is
// "src" (required so `tsc`'s build output lands at dist/index.js, not
// dist/src/index.js), so anything outside src/ isn't part of that TS
// project. prisma/seed.ts is a one-off script run via `tsx` (not part of the
// compiled build), so it's left out of type-aware linting rather than
// building a second tsconfig just to cover one file.
import love from 'eslint-config-love'

export default [
  {
    ...love,
    files: ['src/**/*.ts'],
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
]
