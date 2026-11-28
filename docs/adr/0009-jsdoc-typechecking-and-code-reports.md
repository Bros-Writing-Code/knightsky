# ADR 0009: Add type checking and code reports to CI

- **Status:** Proposed
- **Date:** 2026-11-24
- **Scope:** Development tooling and CI
- **Related:** [Issue #8](https://github.com/Bros-Writing-Code/knightsky/issues/8), [Deployment](../deployment.md)

## Context

Several JavaScript files already use JSDoc types and `// @ts-check`. We need CI to check those types and show reviewers unused files, unused packages, and copied code.

## Decision

- Use TypeScript to check JavaScript files marked `// @ts-check`, without generating files. Teams can opt in one file at a time. Type errors fail CI and block deployment.
- Use Knip to report unused files and packages. Keep unused-export reporting off because engine functions may still be waiting for UI callers.
- Use jscpd to report copied code, including matching file locations, in the workflow summary alongside the Knip report.
- Keep report findings advisory. A reporting tool failure still fails the reporting job.
- Exclude dependencies, generated files, bundled Stockfish assets, and local worktrees from scans.
- Preserve the existing CI check names and ESLint rules.

## Consequences

This keeps the project in JavaScript and allows gradual adoption. The tools add development dependencies and CI time. Reports may flag intentional code, so findings need review before anything is removed.

## Verification

Local checks passed, including all 236 tests. A temporary example confirmed that type checking is opt-in and was removed afterwards. Both reports returned success despite findings, and the captured duplicate report includes file locations.

GitHub verification is pending: confirm that the PR checks run, both reports appear in the summary, and deployment depends on type checking.
