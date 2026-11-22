## What and why

<!-- What does this PR change, and why? Link the issue: "Closes #123". -->

## How to check it

<!-- Steps for the reviewer, or "tests only". -->

## Checklist

- [ ] Branch is up to date with `main`
- [ ] `npm run lint`, `npm run format:check`, `npm test` and `npm run build` pass locally
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`)
- [ ] Tests added or updated for the new behaviour
- [ ] ADR added in `docs/adr/` if this adds new functionality or changes the code structure (use `docs/adr/0000-template.md`)
- [ ] Version bumped in `package.json` and `index.html` if this adds a feature (see below)
- [ ] Docs updated if behaviour changed

<!--
Version (Semantic Versioning, MAJOR.MINOR.PATCH):
- New feature that doesn't break anything: bump MINOR (1.1.0 -> 1.2.0)
- Bug fix: bump PATCH (1.1.0 -> 1.1.1)
- Breaking change: bump MAJOR (1.1.0 -> 2.0.0)
- Docs, CI or tooling only: no bump
-->
