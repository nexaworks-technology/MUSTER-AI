# Rename: the product is now "Muster AI" (2026-11-12)

The PRODUCT is **Muster AI**. **NexaWorks** is the COMPANY and was left alone wherever it names the
company (the dictation disclosure "not by NexaWorks", `CLAUDE.md`'s "by NexaWorks", the export format id,
infrastructure names). Single source: `PRODUCT_NAME` in `src/config/product.ts`, now `"Muster AI"`.

## Surfaces changed

| Surface | How it follows |
|---|---|
| Constant | `src/config/product.ts` = "Muster AI" (comment now states product vs company). |
| Page titles and meta, sign-in page, app sidebar workspace subtitle, invite page and invitation email subject/body, unsubscribe, survey and portal titles, the Ask AI byline | Already read the constant; follow with no edit. Verified on screen (screenshots below). |
| Settings › Integrations (Slack card: "You will add the … app to your Slack") | Was a literal "NexaWorks app"; now `${PRODUCT_NAME}`. |
| Slack interactivity replies (three messages) and the "already connected to another … workspace" message | Were literal "NexaWorks"; now `${PRODUCT_NAME}`. |
| CRM write-back description ("Found by … from the customer's usage") | Was literal; now `${PRODUCT_NAME}`. |
| Demo seed: the NPS survey question | Was literal; now `${PRODUCT_NAME}`. (Note: it names the product inside the Larkspur demo workspace, as before; that wording choice is unchanged.) |
| `scripts/healthcheck.ts` banner | Now prints `${PRODUCT_NAME}`. |
| `scripts/deploy-release.sh` banner | Product name dropped ("Production Deployment & Release Runner"): the test below forbids the literal in `scripts/`. |
| `Dockerfile` and `docker-compose.yml` header comments | "Muster AI". |
| `README.md` | Title "# Muster AI"; the "internally still called NexaWorks CSM" line rewritten (product vs company, and why some infra names stay). |
| `CLAUDE.md` title, `docs/ARCHITECTURE.md` title and PRODUCT_NAME row, `docs/IMPLEMENTATION_PLAN.md` title, `docs/QUESTIONS.md` Q-01 | Updated (living documents). Q-01 now records the decision. |

All new strings use `PRODUCT_NAME`, not the literal, because the existing test
(`src/config/__tests__/product-name.test.ts`) fails if the name's literal appears anywhere in `src/`,
`e2e/`, `prisma/` or `scripts/` outside `product.ts`. That test, unchanged, passes with the new value.

## Tests

Name assertions only. `interactivity.int.test.ts` (two Slack message assertions) now builds the expected
text from `PRODUCT_NAME`. New `e2e/rename-muster.spec.ts`: the sign-in heading and tab title carry the
product name; the Ask byline and the shell show it; the old working name is absent from the page HTML.

## Verification

- `pnpm typecheck`, `pnpm lint` (ESLint and secret scan, 1,680 files): pass.
- Vitest (product-name, Slack interactivity, theme, surveys, settings, integrations and seeds):
  175 passed, 5 failed. **The 5 failures are `export-roundtrip` / `purge` and are not caused by the
  rename: see "Disk is full" below.**
- e2e (production build, both AI configs): `rename-muster`, `m1-foundation` (sign-in heading,
  invitation), `ask-redesign`, `design3-s1`, `a11y-m11` (desktop and mobile): 16 passed, 0 failed;
  AI-off run passed.
- Not run: the full gate and the full e2e suite. The Docker stack was not rebuilt.

## Grep result (old product name "NexaWorks AI CSM" / "NexaWorks CSM" / "NexaWorks AI Customer Success Manager")

Zero product-facing occurrences remain in `src/`, `e2e/` (except the test constant below), `prisma/`,
`prompts/`, `scripts/`, `Dockerfile`, `docker-compose.yml`, `README.md` and `CLAUDE.md`.
Intentionally left (history or fixed references):

- `ai-customer-success-manager-complete-product-spec-2026-10-31.md`: the dated source-of-truth spec; its
  own open question 1 ("Final name before prototype") is now answered by Q-01.
- `docs/milestones/*` (M1 to M12 logs and briefs), `docs/REVIEW-2026-11-*.md`, `docs/ASK-REDESIGN.md`:
  dated history, unedited.
- `docs/ARCHITECTURE.md` and `docs/QUESTIONS.md` each mention the old name once, deliberately, as "was
  the working name".
- `e2e/rename-muster.spec.ts` holds the old name as the string it asserts is absent.
- Not product references, so unchanged: docker compose project `nexaworks-csm`, queue prefixes
  `nexaworks-*`, DB role `nexaworks_owner` and database names, MinIO bucket names, the
  `NEXAWORKS_PROCESS` env var, the export format id `nexaworks-workspace-export/1`, the GitHub repo name.
  Renaming those would break existing volumes, queues and exports.

## Found while verifying: the host disk is full

`/System/Volumes/Data` is at **100% (696 MiB free of 228 GiB)**. MinIO answers every write with
`XMinioStorageFull` (HTTP 507). That is the cause of the 500 on `POST /api/ask/files` in the earlier
Ask redesign session (the "attach the contract PDF" e2e that was reported as failing before that change
too) and of the failing `export-roundtrip` and `purge` tests. Nothing was deleted. Docker reports 35.8 GB
reclaimable in unused images and 6.2 GB in stopped containers; clearing space is your call.

## Screenshots

`docs/design/rename-signin.png` (sign-in page: "Muster AI"), `docs/design/rename-ask-byline.png`
(Ask answer byline and sidebar: "Muster AI").
