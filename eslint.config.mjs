import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  //
  // IMPORTANT: patterns here are resolved relative to THIS config file's
  // directory (the repo root), not to whatever cwd eslint is invoked from.
  // Since every app under apps/* is linted via `cd apps/<name> && eslint .`
  // (npm workspaces sets cwd per-package), a bare "out/**" only matches
  // <root>/out/**, never apps/<name>/out/**. Without the leading "**/", a
  // lint run after a build silently scans the entire minified build output
  // as source — this previously inflated one app's lint run from ~600
  // problems to 26,000+. Keep the "**/" prefix.
  globalIgnores([
    // Default ignores of eslint-config-next:
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/next-env.d.ts",
  ]),
  // This workspace predates the React Compiler rules and has a substantial
  // typed-debt backlog. Keep every finding visible while allowing the lint
  // command to act as a release gate for syntax and build-breaking defects.
  // These rules remain warnings until their targeted remediation is complete.
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      'react/no-unescaped-entities': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'prefer-const': 'warn',
    },
  },
]);

export default eslintConfig;
