## Summary
<!-- What changed, and why? Keep the scope focused. -->

## Linked issue or discussion
<!-- Every PR should link an existing issue or discussion (CONTRIBUTING.md). -->
Closes #

## What changed
<!-- Concise outline of the implementation and any behavior changes. -->

## Validation
<!-- Mark checks actually run. If not run, explain why (especially hardware-dependent tests). -->
- [ ] `./scripts/quality/all_quality.sh`
- [ ] Relevant targeted unit / integration tests
- [ ] UI / E2E / manual tests where appropriate

**Test results and omissions:**
<!-- State what was executed, on what environment, and anything untested. -->

## Compatibility and risk
<!-- If not applicable, write "N/A". -->
- Radio / MeshCore message handling or RF traffic impact:
- API, WebSocket, database, or persistent-settings compatibility:
- Security, secrets, and privacy impact:
- Rollout, rollback, and migration considerations:

## Contributor checklist
- [ ] PR is linked to a pre-existing issue or discussion
- [ ] Behavior changes and important tradeoffs are documented
- [ ] Required generated API schema/types updated if FastAPI contracts changed (`cd frontend && npm run api:generate`)
- [ ] New or changed behavior has appropriate tests (or documented justification)
- [ ] No new failing lint, typecheck, tests, or build results
- [ ] No unintended automated RF traffic or internet-to-mesh ingestion
- [ ] Relevant documentation / changelog is updated where necessary

## Screenshots / recordings (if UI changes)
<!-- Add before/after screenshots where they clarify the change. -->
