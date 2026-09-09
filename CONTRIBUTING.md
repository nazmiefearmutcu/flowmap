# Contributing to FlowMap

Thanks for helping. This page covers setup, the commit style the repo uses, and what a
maintainer will check before merging.

## Dev setup

Prerequisites: Python 3.13 with [uv](https://docs.astral.sh/uv/), Node 22 with npm.

```bash
# server venv + deps (crocodile is pinned to a git rev in server/pyproject.toml)
cd server && uv sync

# client deps
cd client && npm install

# boot both (server :8720 + vite :5173) — pick whichever fits your OS
./scripts/dev.sh                       # bash
powershell -File scripts/dev-windows.ps1
bash scripts/dev-unix.sh
```

Then open http://localhost:5173 and pick `SIM-DEMO` for an offline deterministic feed.
See [docs/development.md](docs/development.md) for test commands and e2e prerequisites, and
[docs/architecture.md](docs/architecture.md) for how the pieces fit.

On Windows, prefer an ASCII-only checkout path — vite's dev server can fail when the project
path contains non-ASCII characters.

## Commit style

This repo uses **conventional commits**:

```
<type>(<optional scope>): <imperative summary>

<optional body>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `chore`, `ci`. Scope is the
area (`client`, `server`, `app`, `proto`, `e2e`, ...). Examples:

```
feat(server): refuse stale replay re-attach with replay_stale token
fix(client): keep price zoom when re-arming price follow
docs: document FLOWMAP_LOG_FILE
```

## PR checklist

Before opening a PR, please confirm:

- [ ] **Tests green.** `cd client && npm test` (~626 vitest tests) and
  `cd server && uv run pytest -q` (~450 pytest tests) both pass locally, and new behavior has
  tests.
- [ ] **TypeScript clean.** `npx tsc -b` in `client/` reports no errors.
- [ ] **The honest-data rule holds.** Never render, badge, or replay data that the feed did not
  actually deliver: capability badges (`L2`/`L1`/`SYNTH`, `TAPE TICK`/`TAPE POLL`) must reflect
  what the active stream provides; synthetic depth stays in its own ramp with its own badge;
  a replay that would show a stale or missing recording is refused, not faked. If your change
  touches this, say so explicitly in the PR description.
- [ ] **Wire changes are lockstep.** If you touched `server/src/flowmap_server/proto/` or
  `client/src/proto/`, both sides and the frozen golden vectors agree — protocol changes are a
  versioned event, not a drift.
- [ ] **Docs updated** where behavior or flags changed (README configuration table,
  [docs/architecture.md](docs/architecture.md), [SECURITY.md](SECURITY.md) for anything
  security-adjacent).
- [ ] **No new binary assets** in a PR that doesn't explicitly need them.

CI runs both suites on every push and PR (`.github/workflows/ci.yml`); a maintainer will ask for
rebases rather than merge commits if the branch has drifted.

## Reporting bugs and vulnerabilities

Bug reports: a GitHub issue with what you ran, what you expected, what happened, and the feed
(`sim:SIM-DEMO` reproduces without network access). Security issues: a
[private security advisory](https://github.com/nazmiefearmutcu0/FlowMap/security/advisories/new),
never a public issue — see [SECURITY.md](SECURITY.md).

## Licensing

By contributing you agree your work is released under the repository's
[Apache-2.0 license](LICENSE).
