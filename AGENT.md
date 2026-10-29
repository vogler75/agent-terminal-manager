# Notes for coding agents working on this repository

## CI on GitHub

- Do **not** trigger GitHub Actions (no `gh workflow run`, no re-runs, no re-enabling push/PR triggers).
- `.github/workflows/build.yml` runs only on manual dispatch (`workflow_dispatch`). The maintainer starts it by hand once the app has reached a stable state.
- `.github/workflows/release.yml` runs when a version tag `v*` is pushed. Only the maintainer creates and pushes version tags; agents never push tags.
- The version lives in `version.txt`; change it only with `node scripts/version.js <x.y.z>` (also updates `package.json` and `package-lock.json`). `release.ps1` publishes a release and is run by the maintainer only.
- Verify changes locally instead: `npm test` (unit tests) and `npm run e2e` (Playwright drives the real app; see README for the optional `ATM_E2E_SSH`, `ATM_E2E_WSL` and `ATM_E2E_OPENCODE` targets).

## Project basics

- Electron app: main process in `src/main`, renderer in `src/renderer` (bundled by `scripts/build-renderer.js` into `dist/`).
- Coding agent adapters: `src/main/coding-agents/registry.js` (one adapter per agent on the shared interface in `base.js`); deploy runner in `deploy.js`. Local Windows projects use PowerShell, everything else `sh`, so test both paths.
- UI texts are English.
