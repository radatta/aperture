---
paths:
  - 'lambdas/**'
---

# Editing `lambdas/`

- **Writes discipline (BFF):** every external write (POST/PUT/PATCH/DELETE) is declared in one `writes` object at the
  top of the handler and nowhere else — helpers call functions passed in via `writes`, never write APIs directly.
  Single audit point; guarantees no writes fire during any test/smoke run. Home: `docs/product/CONVENTIONS.md` →
  _BFF writes_.
- External calls go only through the gated gateways; JWT and origin-secret handling stay in-handler
  (gateways: `docs/arch/TECH.md` → _Beyond the BFF_ and the `lambdas/src/` tree; the edge: `docs/arch/INFRA.md` §4). The review round's backend checklist: `docs/ops/FEATURE-WORKFLOW.md` → phase 6.
- Tests run in Vitest's **node** env, so they match the Lambda's prod runtime; the node-env handler tests are the
  runtime proof (no second review agent).
- Page-first: a backend half follows a frontend that already passed its rounds — check the lambda against the
  contract the stub set.
