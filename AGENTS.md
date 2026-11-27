# AGENTS.md

## Project
- There is no game server. Each player's browser runs its own copy of the engine, and moves are records in each player's PDS that the opponent's client reads.
- The chessground demo (`src/app/chessground-demo`) uses `src/engine` through the `game.js` adapter.
- Engine code is plain JS: plain objects with separate functions, no piece classes (ADR 0003), and a 0x88 board (ADR 0002).
- See `docs/ubiquitous_language.md`.
- There are lint scripts. Use `npm test`, `npm run build`, `npm run dev`, `npm run lint`, `npm run lint:fix`, `npm run format`, and `npm run format:check`. No typecheck script yet.
- This is a course project with a short deadline, so prefer simple solutions over new tooling.
- Never commit to `main`. Branch from an up-to-date `main`. Changes merge only through a PR with a merge commit, after approval from a different human.

## General practices
- Ask before assuming. Turn vague requirements into concrete, measurable ones and confirm them.
- Be pragmatic: simplest solution that fits (KISS, YAGNI), no premature optimization or abstraction. State trade-offs.
- Plan briefly before non-trivial work; keep plans and decisions in the repo as the single source of truth.
- Start from the user's model and the relevant "-ilities" (usability, accessibility, performance, security); say how each is verified.
- High cohesion, loose coupling; every abstraction must earn its complexity.
- Default to semantic HTML and accessibility. Performance targets: respond <100ms, 60fps, load <1s.
- Work in small increments with tests; flag tech debt you take on. Code is writing: clear names, comments explain why.
- Record significant architectural decisions as short ADRs (follow the existing ones) and keep docs in sync.
- Use the templates: `docs/adr/0000-template.md` for ADRs (pick the next free number, also check open branches), `.github/ISSUE_TEMPLATE/` for issues, and `.github/PULL_REQUEST_TEMPLATE.md` for PRs. Fill every section of a PR and tick its checklist honestly.
- Versioning follows Semantic Versioning in `package.json` only; `vite.config.js` fills the `index.html` footer from it, so never edit the version there. New feature: bump MINOR. Bug fix: bump PATCH. Breaking change: bump MAJOR. Docs, CI or tooling only: no bump. Never lower a released version.
- Name branches like Conventional Commits (`feat/3d-bar-chart`, `fix/mobile-button-overlap`). Commit messages use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`). Keep branches short-lived and merge `main` in often.
- Before a PR: the ADR (if needed), `main` merged in, then lint, format check, tests and build pass locally. Exported functions get a docstring comment and new behaviour gets unit tests.
- Prefer to let humans write docs, pr names and descriptions, and commit messages. Always ask for them to give it to you first.
- Generally follow the [process document page](https://github.com/Bros-Writing-Code/knightsky/wiki/Process) from the wiki.
