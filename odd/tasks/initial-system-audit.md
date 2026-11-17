# Feature: initial-system-audit

## Objective

Full technical audit of the legacy RassaJala system (`legacy/rassa_back`: Django 5 + DRF; `legacy/rassa_front`: Expo mobile + Vite/React 19 web + shared packages), producing 5 audit documents in `docs/01-audit/` as the factual basis for a new independent app (React+TS, Bun+tRPC, Prisma, Supabase Postgres, RxDB, offline-first PWA).

## Problem / Why

The new implementation must not reuse legacy code; it needs a verified inventory of the original data model, business rules, features, and frontend-backend correspondence before design starts.

## Authorized scope (mutation)

- CREATE: `docs/01-audit/backend-audit.md`, `frontend-audit.md`, `database-audit.md`, `functional-map.md`, `audit-findings.md`
- CREATE: `odd/tasks/initial-system-audit.md` (this tracker)
- `legacy/**`: strictly READ-ONLY. No schema changes, no implementation, no code reuse.

## Constraints

- Every finding cites repo-relative legacy paths (line refs where useful).
- CONFIRMED vs INFERRED explicitly separated; nothing assumed beyond the repos.
- Missing/ambiguous/contradictory info documented, never invented.
- Audit docs in English (neutral professional); conversation in Spanish.

## Route declaration (per ODD delegation triggers)

- T1 recon + tracker: inline (mechanical routing reads).
- T2 backend+database docs: DELEGATED writer (mapping trigger: 149 py files + bruno/ + db/ far exceed 4 files; writer trigger: 2 non-trivial files).
- T3a mobile exploration: DELEGATED explorer (read-only mapping, 300+ files).
- T3b web exploration: DELEGATED explorer (read-only mapping, 260+ files).
- T3c frontend-audit.md: DELEGATED writer (single doc from T3a+T3b reports; avoids two workers editing one file).
- T4 functional-map + findings: DELEGATED writer (depends T2+T3c).
- T5 verification gate: inline structural readback + citation check + legacy-untouched check.
- T6 close: inline (engram mirror, session summary, report).

## TDD

Off — documentation-only deliverables, no test runner applies (source: task nature). Functional checks: structural readback + cited-path existence verification + `git status` isolation check.

## Delivery

Forecast: 5 markdown docs, est. 1200–2400 authored lines total. Strategy: ask-on-risk (default). Agents create no commits/PRs: runtime policy keeps commits user-owned; delivery is the user's decision under ordinary repo policy.

## Checklist

- [x] T1 recon (stacks, sizes, skill registry, engram) — 2026-11-16
- [x] T2 backend-audit.md + database-audit.md (worker A, delegated)
- [ ] T3a mobile exploration report → engram `odd/initial-system-audit/frontend-mobile-explore`
- [ ] T3b web exploration report → engram `odd/initial-system-audit/frontend-web-explore`
- [x] T3c frontend-audit.md (writer, from T3a+T3b)
- [x] T4 functional-map.md + audit-findings.md incl. offline-first analysis
- [x] T5 gate: 5 docs exist, citations resolve, legacy/ untouched, assess tier recorded
- [x] T6 close: mirror update + session summary + final report

## Acceptance criteria

- 5 deliverables exist in `docs/01-audit/` with confirmed/inferred separation and legacy file references.
- Data model reconstructed: PK/FK, relations, required fields, indexes, enums, constraints, migrations inventory.
- Functional map links frontend features to backend endpoints/models/operations; incomplete features and inconsistencies flagged.
- Offline-first analysis: entities needing local persistence, offline read/write, bidirectional sync, versioning, conflict resolution — analysis only, nothing implemented.
- Open questions documented explicitly.

## Progress

- T1 done 2026-11-16: Django 5+DRF backend (149 py files, bruno API collections, db/, docs/); frontend Expo mobile (319 files) + Vite web (268 files) + 4 shared packages (48). No prior audit artifacts found.
- T2 done 2026-11-16: worker wrote backend-audit.md (11 sections, 14 resource families, 60+ business rules, 85 cited legacy paths) + database-audit.md (34 entities, 31 migrations, ER diagram). Worker self-verified citations + git isolation; parent readback pending (T5). Key: login does not check Usuario.estado; db/archive SQL superseded; PG-specific concurrency; dual Google Drive image pipelines; financial invariants only in app code.
- T3c done 2026-11-16: frontend-audit.md written from engram reports 922/923/924 + 6 spot checks; 142 distinct legacy paths cited (grep clean), git isolation ok. Key: admin CRUD mocked (web local-state AdminCrudTable, mobile hardcoded AdminProductsScreen); checkout machinery divergent (mobile AsyncStorage in-flight record vs web checkoutGuard.ts 419L dual-storage), idem_pago_* never cleaned up; 106 API ops / ~90 paths; PUT vs PATCH verb mismatch on /productos/{id}/; role vocabulary conflict (mobile EN farmer|seller|admin|buyer vs web ES agricultor|vendedor|admin|cliente); dead code: packages/api, packages/design-tokens, AdminDashboardScreen/AdminUsersScreen, routes/admin.tsx. Parent readback done (T5).
- T4 done 2026-11-16: functional-map.md (14 domain correspondence tables, 6 lifecycle narratives, 12 backend-only endpoints + 6 flagged mismatches, 24-row completeness table) + audit-findings.md (F-01..F-31 confirmed, I-01..I-12 inferences, 5 inconsistency groups, Q-01..Q-33 register with 29 open, offline-first classification of 17 entities labeled Analysis-only, 8 read-only next-evidence steps). Worker self-verified citations + git isolation; engram digest obs 928.
- T5 done 2026-11-16: parent gate PASS — 5 docs exist (3551 lines); citation grep across all 5 clean (0 missing); git isolation ok (footprint docs/ + odd/ only; legacy/ untouched); heading structure coherent; offline-first section readback conforms to analysis-only mandate; end-to-end spot checks: F-17 verified exactly (IsAdminOrReadOnly at productos_views.py:57,95,223); F-01 verified (estado=True at auth_serializers.py:52 belongs to validate_fk_localidad — Localidad/municipio validation — not a Usuario.estado login check). review assess: unassessable (legacy/ holds nested git repositories; changed_paths 0) → recorded as high per contract; content is passive documentation, so proportional check = structural readback + sampled claims; native review not run (RDD off, user-owned switch).
- T6 done 2026-11-16: final engram mirror upserted, session summary saved, final report delivered to user. Commits left to the user (runtime denies git commit; ordinary repository policy applies).
