# Main CI/CD warning review — 2026-10-23

Sources: the latest completed runs on `main` as of 2026-10-23
(commit `50f2900bfb2148c6c86c9d55207b8fc96159d5ae`).

- [All Quality #641](https://github.com/Bjorkan/MESHRIK/actions/runs/39920443941)
  (frontend-checks, backend-checks, Docker publish)
- [CodeQL #357](https://github.com/Bjorkan/MESHRIK/actions/runs/39920443921)
  (Python and JS/TS)
- [autofix.ci #336](https://github.com/Bjorkan/MESHRIK/actions/runs/39920444216)
- Previous successful [All Quality #619](https://github.com/Bjorkan/MESHRIK/actions/runs/39717075320)
  for comparison.

## Fixed in the accompanying PR

1. **Vite native config loader migration warning:** Both Vite and Vitest
   report that `__dirname` cannot work with Vite's forthcoming native
   config loader. Use `import.meta.dirname` in both config files.
   Supported by the project's Node 24 CI/runtime and current `@types/node`.
   No flag is used to suppress the warning.
2. **Unawaited `AsyncMock` (backend pytest):** Four tests in
   `TestBroadcastEventRealtime` replace `ws_manager.enqueue` with
   `AsyncMock` although it is a **synchronous** method. Calling it
   produces `RuntimeWarning: coroutine ... was never awaited`.
   Use `MagicMock` and retain the existing call-count assertions.

## Findings needing separate, evidence-driven work

These warnings are **not** silenced or labeled fixed by this PR:

- **npm audit: 9 dependency vulnerabilities (2 moderate, 7 high)**
  in all frontend `npm ci` runs. The log does not identify packages,
  exploitability, production vs. dev reachability, or fixes. Run a full
  `npm audit --json` and review the exact advisory paths before updating
  the lockfile. Do **not** run `npm audit fix --force` blindly: it can
  introduce incompatible major upgrades.
- **`crypto-js@4.2.0` is unmaintained**. Lockfile confirms it is
  pulled in via `meshcore-hashtag-cracker@1.11.0` and its nested
  decoder. Removing this deprecation is an upstream dependency or
  compatibility migration, not just a root version bump.
- **`eslint@9.39.5` is no longer supported**. Migrating to a
  supported major must include testing the shared ESLint configuration,
  `typescript-eslint`, hooks plugin, autofix and checked-in lockfile.
  Do not bump only `package.json` without regenerating the lockfile.
- **Frontend React `act(...)` warnings:** The Vitest logs show numerous
  unwrapped asynchronous updates across `useUnreadCounts`,
  repeater/dashboard, router, map, settings and other tests. Correct
  the relevant test scheduling/cleanup with targeted reproduction,
  rather than globally suppressing `console.error` or test warnings.
- **Vite >500 kB chunks:** The build logs identify a ~5.0 MB wordlist
  chunk, ~1.1 MB MapLibre GL chunk, and ~625 kB visualizer chunk.
  These need route/lazy-load and network-size investigation; simply
  raising `chunkSizeWarningLimit` would hide useful output.
- **Third-party Python deprecations:** Starlette/FastAPI's
  `httpx` TestClient adapter warns that `httpx2` is preferred.
  `meshcore_py` calls `asyncio.iscoroutinefunction` (deprecated
  ahead of Python 3.16). Upgrade only with verified FastAPI/Starlette
  or upstream `meshcore_py` compatibility, respectively; do not
  patch site-packages or suppress all DeprecationWarnings.
- **Expected negative-path test logging** (e.g. failing fanout
  config health refresh) is intentional test coverage, not necessarily
  a production error. Tests can capture/assert targeted messages if
  they obscure actual failures.
- **Docker Buildx cache reservation race:** The publish job logs
  `Failed to save: Unable to reserve cache ... another job may be
  creating this cache` during QEMU cleanup, but the publish
  succeeded. This is a cross-run cache contention note, not a
  demonstrated broken deployment.
- **Git init default-branch hints** are runner/bootstrap output,
  not an application deprecation. CodeQL's `DEPRECATED` text in
  autobuilder option metadata is not evidence of an active use
  of the deprecated option.

## Validation checklist

- [ ] GitHub PR `frontend-checks` completes.
- [ ] GitHub PR `backend-checks` completes and the unawaited
      `AsyncMock` warning disappears.
- [ ] Frontend tests and build no longer emit the Vite
      `configLoader: native` `__dirname` warning.
- [ ] Confirm npm audit and the other documented follow-up warnings
      remain visible; no global warning suppression was introduced.

No application runtime, dependency lockfile or Docker release behavior
is intentionally changed.
