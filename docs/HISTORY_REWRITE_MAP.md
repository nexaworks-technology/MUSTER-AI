# History rewrite map (M12, 2026-11-06)

The history was rewritten twice before the repository was ever pushed or shared (M12 rule 1, Q-78), with `git filter-repo` 2.47.0 (D-172):

1. **A2:** the two rotated Q-78 local database passwords, the removed M10 survey fallback string, and two fake test-fixture literals that matched token shapes.
2. **A10 follow-up** (founder-approved): the removed M8 unsubscribe fallback signing key, found by A10's audit.

Every commit hash changed. **Milestone logs M1–M11 cite the ORIGINAL hashes**; the first table maps each to its FINAL hash (the A2-stage hash is shown for completeness). The second table maps the M12 Session A commits made between the two passes (cited in M12-LOG before the second pass) to their final hashes. Two untouched backups are kept outside the working tree (paths in M12-LOG).

## Pre-M12 history (220 commits)

| Original | After A2 | Final | Date | Subject |
|---|---|---|---|---|
| `c6babc7` | `c6babc7` | `c6babc7` (`c6babc7219e695532e4db9c7c28995456f908691`) | 2026-10-31 | docs: product spec, architecture, plan and milestone prompts |
| `ec75866` | `ec75866` | `ec75866` (`ec7586633460464338070faef596bce65d6ea184`) | 2026-11-02 | chore: scaffold Next.js app with strict TypeScript, Tailwind, shadcn/ui and lint boundaries |
| `82aa7d5` | `82aa7d5` | `82aa7d5` (`82aa7d50ea8a2629278b9c657f68dce6057b2a26`) | 2026-11-02 | chore: add Vitest, Playwright + axe, env schema and secret scanning |
| `08c3c32` | `08c3c32` | `08c3c32` (`08c3c32c51c8c34c3e82fde07fdfc2046a476991`) | 2026-11-02 | chore: add local services (compose + native fallback) and Prisma |
| `2714a12` | `2714a12` | `2714a12` (`2714a12b65a1e1986191cd9eb05264623288df16`) | 2026-11-02 | feat(db): identity and tenancy schema with row-level security |
| `2d268be` | `2d268be` | `2d268be` (`2d268be46d09a1edb6aefdf57f07d804215147d6`) | 2026-11-02 | feat(db): tenant-scoped Prisma client with RLS and isolation tests |
| `cdeeaea` | `cdeeaea` | `cdeeaea` (`cdeeaeadfacbb25136f90129ce1ddd2ecaef10c0`) | 2026-11-02 | feat(auth): Auth.js with database sessions for Google and email/password |
| `c5f836b` | `c5f836b` | `c5f836b` (`c5f836b651e1d7868c007bc0ea39f63b0aaade78`) | 2026-11-02 | feat(auth): RBAC permission map with book scope and revenue flag |
| `b09abc2` | `b09abc2` | `b09abc2` (`b09abc25c7d177c3cea4b42659196a5795a32e29`) | 2026-11-02 | feat(audit): append-only audit writes with redaction and auth events |
| `441a50d` | `441a50d` | `441a50d` (`441a50d6a41e65029943398333914c69b6346f7c`) | 2026-11-02 | feat(settings): users, invitations, workspace profile and the app shell |
| `19aef18` | `19aef18` | `19aef18` (`19aef1845ea86eef37e1f0e984f16aa845654ff7`) | 2026-11-02 | feat(jobs): BullMQ queues, transactional outbox and worker process |
| `1557ef7` | `1557ef7` | `1557ef7` (`1557ef7cf1f4ccc9782abdd4dcb3efb2f9daa29d`) | 2026-11-02 | feat(ai): provider seam, versioned prompt loader and recorded provider |
| `2f3008f` | `2f3008f` | `2f3008f` (`2f3008f0dfc373c36ad18ebe29e74a3013c6d92d`) | 2026-11-02 | feat(lib): storage wrapper and money helpers |
| `1400d4b` | `1400d4b` | `1400d4b` (`1400d4bb3b403da7e4cd4a4b9d7ae337ff0c3115`) | 2026-11-02 | feat(seed): demo workspace seed v0 and pricing structure config |
| `a6f924f` | `a6f924f` | `a6f924f` (`a6f924f706d38fe16206abc41b2bff2b3779270c`) | 2026-11-02 | test(e2e): M1 demo flow, second-tenant isolation and accessibility checks |
| `64f3880` | `64f3880` | `64f3880` (`64f38809b4af20dcd3eb1f78249a790c3ea1726f`) | 2026-11-02 | chore: deny optional msgpackr native build; test workspace-switch refusal |
| `53cc574` | `53cc574` | `53cc574` (`53cc5745b74be2233c2b7fd3a8adeb3ef4aa5c64`) | 2026-11-02 | docs(m1): milestone log, acceptance results, changelog and decisions D-36–D-40 |
| `ac98182` | `ac98182` | `ac98182` (`ac9818248eb7c82b568356d4cecd7548202a0371`) | 2026-11-02 | feat(accounts): Account, Contact and StakeholderRole with tenancy, seed roster |
| `ac133b5` | `ac133b5` | `ac133b5` (`ac133b56f2920a3fc206c3dc27cfdbb2a1271c53`) | 2026-11-02 | feat(accounts): server-paginated Accounts list with search, filters and sort |
| `dba7c38` | `dba7c38` | `dba7c38` (`dba7c38568a2e9ba4103954b485cb01d8c659373`) | 2026-11-02 | feat(accounts): Account 360 with Overview and People, champion designation |
| `3710c0d` | `3710c0d` | `3710c0d` (`3710c0d2f9e397347d188ffe6e8db8b89d101a9d`) | 2026-11-02 | feat(billing): contracts, subscriptions, invoices and rule-derived revenue events |
| `75009df` | `75009df` | `75009df` (`75009df46775cf9e47cd6a25d9395dda2d0948e0`) | 2026-11-02 | feat(usage): daily usage aggregates, Usage tab chart and seeded usage stories |
| `f881121` | `f881121` | `f881121` (`f881121ff79c5cc638738d5cee4d1ee369bbc9d6`) | 2026-11-02 | feat(support): tickets, conversations and call transcripts with seeded evidence |
| `0d5b80a` | `0d5b80a` | `0d5b80a` (`0d5b80a35e0a0cb3e3f55005392b2156d138e6fb`) | 2026-11-02 | feat(tasks): tasks, notes with templates and mentions, notifications |
| `f74ac46` | `f74ac46` | `f74ac46` (`f74ac4668e27ef04ac3c518ce062c2b94f0e5d97`) | 2026-11-02 | feat(timeline): account timeline from every M2 source with stable paging |
| `cd96d1f` | `cd96d1f` | `cd96d1f` (`cd96d1f92bbda537c006709f0a7030f9ecb37e94`) | 2026-11-02 | feat(accounts): inline edit and the ARR tier rule |
| `4627d75` | `4627d75` | `4627d75` (`4627d7526e94712ac69e84545a6b65bb4eef3d79`) | 2026-11-02 | feat(segments): saved segments with a validated filter language |
| `2ac0153` | `2ac0153` | `2ac0153` (`2ac0153db1be881f646da92cfaf4ad2e6247ecb8`) | 2026-11-02 | feat(files): upload safety with content checks, scoped keys and guarded downloads |
| `71aee0d` | `71aee0d` | `71aee0d` (`71aee0dc17dcde8acdb3150a243d7af9ebf32f70`) | 2026-11-02 | feat(imports): CSV import with mapping, dry-run preview and idempotent background runs |
| `39917f4` | `39917f4` | `39917f4` (`39917f42131b22bdcd38b6f91fb9b53f55809b35`) | 2026-11-02 | feat(accounts): missing-data helper — one question at a time, skippable, never blocking |
| `2c258af` | `2c258af` | `2c258af` (`2c258afc3a3f424515712490d5d3128c168bf3d1`) | 2026-11-02 | feat(accounts): data-quality checker with confirm-only fixes |
| `95215b5` | `95215b5` | `95215b5` (`95215b55a76db7c6f1e0a101a7e180148c70b379`) | 2026-11-02 | test(e2e): M2 account360 flow, worker in e2e, a11y for M2 screens |
| `6c1093b` | `6c1093b` | `6c1093b` (`6c1093b5a4acdf7c7f3e061a2bb4521c9c73f395`) | 2026-11-02 | docs(m2): milestone log, acceptance results, changelog and decisions |
| `4cc3c92` | `4cc3c92` | `4cc3c92` (`4cc3c92ea770d2fcc1a341866d3c5b5a12bd8129`) | 2026-11-02 | build(lint): raw SQL must filter by workspace (D-40), M3 decisions recorded |
| `f95dc5d` | `f95dc5d` | `f95dc5d` (`f95dc5de11ac3ee1fb2fda6203b98353d7ae6a83`) | 2026-11-02 | feat(dates): workspace calendar helpers and point-in-time contact/ticket dates |
| `211f097` | `211f097` | `211f097` (`211f097ccfb7fb58d945914b42f8d1404f7fb964`) | 2026-11-02 | feat(health): health models with proof enforced by the database |
| `6b64a97` | `6b64a97` | `6b64a97` (`6b64a9771d3ccbd14adb0f14da05b2be5ad9c654`) | 2026-11-02 | feat(health): curves and every health component, golden fixtures first |
| `868dca4` | `868dca4` | `868dca4` (`868dca41010936031ad0f07ac863f473e6d7d097`) | 2026-11-02 | feat(health): own-normal and cohort baselines, pure and in SQL |
| `f18c3b8` | `f18c3b8` | `f18c3b8` (`f18c3b8264ca51059aadbd1ca99e28cd3ddfd653`) | 2026-11-02 | feat(health): aggregation, risk reason, pulse disagreement and writeSnapshot |
| `69a2c0f` | `69a2c0f` | `69a2c0f` (`69a2c0f9e984abafa5fc4ded8f125f00e14dfa8c`) | 2026-11-02 | feat(health): point-in-time loader and scoreAsOf with leakage tests |
| `790b71f` | `790b71f` | `790b71f` (`790b71f632606e57f8361194e0e6f31f339c9b88`) | 2026-11-02 | feat(health): Account 360 Health tab with the Why view and linked sources |
| `7b1a4c6` | `7b1a4c6` | `7b1a4c6` (`7b1a4c6da28bb6dd241774f54e3ce275399799af`) | 2026-11-02 | feat(health): CSM Pulse with immediate re-score and visible disagreement |
| `c67508a` | `c67508a` | `c67508a` (`c67508a30c64340969dbac8af6dede40c10691b0`) | 2026-11-02 | feat(signals): signal, rule and outcome models with database guarantees |
| `3ad0312` | `3ad0312` | `3ad0312` (`3ad0312288f60b05b09020490f0152aa8d7a6831`) | 2026-11-03 | feat(signals): deterministic rule evaluators with golden fixtures |
| `080c6d3` | `080c6d3` | `080c6d3` (`080c6d3eca4f74ffbea8cbe573e9ae4a1c485a31`) | 2026-11-03 | feat(signals): signal lifecycle, outcomes, Signals screens and settings |
| `7b41ccc` | `7b41ccc` | `7b41ccc` (`7b41ccc60d3cb330309c4a935244bae1b3d05726`) | 2026-11-03 | feat(signals): outside signals by hand and by CSV, always with a dated source |
| `98d7009` | `98d7009` | `98d7009` (`98d70093bc169fae51758c60cf25afba5e46b9a5`) | 2026-11-03 | feat(signals): nightly run through the real queue, real-time hook, jobs:nightly |
| `de7980c` | `de7980c` | `de7980c` (`de7980c1c0ebffbdd5b424d1a33e0a93c6a764db`) | 2026-11-03 | feat(health): Health screen with bands, movers and disagreements; Health in the nav |
| `5477579` | `5477579` | `5477579` (`5477579106e4388f665fb44de1d0ff8484744a9a`) | 2026-11-03 | feat(health): back-test, deterministic model proposal, versions and activation |
| `05702b0` | `05702b0` | `05702b0` (`05702b04aa167da5a67d3a4e30e8079456569d88`) | 2026-11-03 | feat(seed): seed v2 with health, signals and back-test fixture; M3 e2e and a11y |
| `3b80425` | `3b80425` | `3b80425` (`3b80425a384e150fa8aebdd518cb5f40b6d85ff0`) | 2026-11-03 | fix(health): every proof link lands on its record; injectable clock in read paths |
| `2fc51e1` | `2fc51e1` | `2fc51e1` (`2fc51e1b3fbbae50633966e322c4137f79bdb5e1`) | 2026-11-03 | fix(signals): "1 person" in seat signals; no stale back-test proposal offered |
| `3d08f69` | `3d08f69` | `3d08f69` (`3d08f698b22ffef56cd41f97f85303e268f13f3b`) | 2026-11-03 | docs(m3): M3 log, acceptance checklist, fresh-database demo evidence, changelog |
| `a13f47b` | `a13f47b` | `a13f47b` (`a13f47bc76804b4fa2308eb35e05cdd82e7136e2`) | 2026-11-03 | docs(review): independent post-M3 review, Q-44 cap evaluation, Q-45 recommendation |
| `bd228ef` | `bd228ef` | `bd228ef` (`bd228ef6418d7a3419fbc580d04fe8e73f694f2b`) | 2026-11-03 | test(tenancy): make the cross-tenant update attack real, with a control |
| `76b622f` | `76b622f` | `76b622f` (`76b622f13d4fc37e84b655292bf9237884f38853`) | 2026-11-03 | test(tenancy): back-test isolation that is guaranteed to run |
| `474c0eb` | `474c0eb` | `474c0eb` (`474c0eba309bb8ccc258abde27e16b8ec53f43ee`) | 2026-11-03 | docs(decisions): D-73 no pillar-floor caps; close Q-44 and Q-45; correct M3 and seed docs |
| `b01fa5b` | `b01fa5b` | `b01fa5b` (`b01fa5b8b687969e2dc05027e5594d9d35f7f616`) | 2026-11-03 | docs(milestones): give the review's orphan deferrals named homes |
| `79d520a` | `79d520a` | `79d520a` (`79d520a7f4e9de11bea55e94f5df2129346201ae`) | 2026-11-03 | feat(agents): M4 models for agent runs, approvals, outbound, today and extraction |
| `877b883` | `877b883` | `877b883` (`877b88312cb4f39befd1222cc12eef7fb2d0067a`) | 2026-11-03 | feat(agents): defineAgent, audited executor with citation and number checks |
| `2a34383` | `2a34383` | `2a34383` (`2a34383707aec74ff5df70bb2a4a7c1ee0d43226`) | 2026-11-03 | feat(outbound): guarded single send path with the sensitive-topic cap |
| `6e84cea` | `6e84cea` | `6e84cea` (`6e84ceac839faa4dbdbbc36c70e551b2bd52474e`) | 2026-11-03 | feat(approvals): approval lifecycle, edit-as-new-version, bulk with exact confirmation |
| `147d565` | `147d565` | `147d565` (`147d565ab7596abf5878e57b19a65e7af01c0168`) | 2026-11-03 | feat(agents): Health Analyst narrative with cited reasons on the Health tab |
| `7eb94be` | `7eb94be` | `7eb94be` (`7eb94bed71431884fda24a1a7923d27eb22b86bc`) | 2026-11-03 | feat(agents): Watcher-basic extraction with verified quotes feeding Sentiment |
| `d8f0596` | `d8f0596` | `d8f0596` (`d8f059620a5a438afbb43095cba7320819137d7d`) | 2026-11-03 | feat(agents): Draft check-in from a signal or ticket, basic Outreach Agent |
| `63bcadd` | `63bcadd` | `63bcadd` (`63bcadd4894b03526426a2a47c6eee9781ced539`) | 2026-11-03 | feat(today): ranked Today queue for each member, Today and Approvals in the nav |
| `2f9fcbe` | `2f9fcbe` | `2f9fcbe` (`2f9fcbe2f0362539b1072372ba1611f58e1d8bf4`) | 2026-11-03 | feat(today): Today is the post-sign-in landing page |
| `efdbae4` | `efdbae4` | `efdbae4` (`efdbae46ff52d282093c1ad5c64d2b702de329da`) | 2026-11-03 | feat(tasks): overdue tasks escalate to the CS Leaders and their Today |
| `972a43d` | `972a43d` | `972a43d` (`972a43ddf784969549c2e84bf9259ee02846c283`) | 2026-11-03 | feat(outcomes): actionTaken tracking and the 7-day checkpoint with evidence |
| `e224a9e` | `e224a9e` | `e224a9e` (`e224a9e40f392a5b9fa6e3204b21dd60f0f400b5`) | 2026-11-03 | feat(audit): audit viewer and audited export; AI team and agent run pages |
| `fbe312f` | `fbe312f` | `fbe312f` (`fbe312fe69639fc7f84c085857696c3b465ea696`) | 2026-11-03 | test(e2e): M4 Today, approvals and AI team flow, plus axe on the new screens |
| `827213f` | `827213f` | `827213f` (`827213f2b35de44d3ebc6f4360e710b7342d45e8`) | 2026-11-03 | fix(agents): narrative about the snapshot the Health tab shows; customer dev mail beside staff mail |
| `b9ec027` | `b9ec027` | `b9ec027` (`b9ec027d190cf968475432c3092cb31052285786`) | 2026-11-03 | docs(m4): M4 log (not yet complete), fresh-database demo evidence, changelog, Q-46 to Q-49 |
| `902f91d` | `902f91d` | `902f91d` (`902f91d27a04fe345bc5141e1e4ec24b4c7f3e88`) | 2026-11-03 | fix(worker): NIGHTLY_SCHEDULES=off so the e2e worker runs no real-clock nightly jobs |
| `f21adb0` | `f21adb0` | `f21adb0` (`f21adb0d3c9b0ed2999ea6becbcd8d7f1d9bd002`) | 2026-11-03 | fix(e2e): recorded-agents waits up to 120 s for the displayed snapshot |
| `5dc3b5b` | `5dc3b5b` | `5dc3b5b` (`5dc3b5bdf6d999ef45618c33d01f4eed2481fee2`) | 2026-11-03 | feat(dates): business clock seam, real time unless a test harness pins it |
| `8a3ce67` | `8a3ce67` | `8a3ce67` (`8a3ce67a2e5c69eb1ab66f6c03a15f21a42fa62f`) | 2026-11-03 | test(e2e): pin the e2e app and worker to SEED_TODAY with the business clock |
| `32d8219` | `32d8219` | `32d8219` (`32d82196ac60ee454c95df23494894d48d5121fc`) | 2026-11-03 | fix(jobs): uniqueness-intended ids come from real time + random, not the business clock |
| `a4ed077` | `a4ed077` | `a4ed077` (`a4ed077e726f027e884d465f5eee060407ec272e`) | 2026-11-03 | docs(m4): M4 complete: final gate and e2e numbers, clock and job-id fixes, Q-49 closed |
| `8c8adb9` | `8c8adb9` | `8c8adb9` (`8c8adb9b51a0013d9c2298e5b7afc77c6b6c7d18`) | 2026-11-03 | feat(integrations): M5 models Integration, SyncJob, WebhookEvent, SlackUserLink with RLS |
| `95664d9` | `95664d9` | `95664d9` (`95664d9a4a79228c216f2bb885d8ef9cdab916ce`) | 2026-11-03 | feat(integrations): adapter framework core (interface, normalized schemas, transports) |
| `11748fb` | `11748fb` | `11748fb` (`11748fb85cbb6ebeb3f560a11bbe8d4211eb48c1`) | 2026-11-03 | feat(integrations): ingest service, one idempotent upsert path through ExternalRef |
| `6515d28` | `6515d28` | `6515d28` (`6515d28da5a04d404ab749a0cae28d5d34e50a9d`) | 2026-11-03 | feat(integrations): sync engine and nightly flow parent |
| `4a14911` | `4a14911` | `4a14911` (`4a149118f1daae48e6197d3a491857b99ab6fb29`) | 2026-11-03 | feat(integrations): OAuth with signed state, sealed tokens, connect and disconnect |
| `43aa092` | `43aa092` | `43aa092` (`43aa0923514dfb612164066b3a72f092bf00ea63`) | 2026-11-03 | feat(integrations): webhook intake, verify before anything, dedupe, process |
| `97c89a0` | `97c89a0` | `97c89a0` (`97c89a06cee68e7c397925f0c80bf388a5d1b5fe`) | 2026-11-03 | feat(integrations): write-back gate with WRITE_BACK approval and audit |
| `f3582ae` | `f3582ae` | `f3582ae` (`f3582ae70eb30655b31dfdc7868b815676cde09a`) | 2026-11-03 | feat(integrations): Stripe adapter, fixtures and contract tests |
| `583cb3e` | `583cb3e` | `583cb3e` (`583cb3e04f125bdc202c606e2dc4c8203e2f9c45`) | 2026-11-03 | feat(integrations): HubSpot adapter, fixtures and contract tests |
| `43b8861` | `43b8861` | `43b8861` (`43b88614761f19b2169d58f9691cb4c1f73db83d`) | 2026-11-03 | feat(integrations): Settings › Integrations screen |
| `4b3e63c` | `4b3e63c` | `4b3e63c` (`4b3e63c57389a16adfaf7808f771be59b296ee4e`) | 2026-11-03 | docs(m5): Session A log, decisions D-82 to D-93, questions Q-50 to Q-53 |
| `85a33ac` | `85a33ac` | `85a33ac` (`85a33acbdc98165d7d8baa730d713b059855d0c4`) | 2026-11-03 | feat(integrations): Salesforce adapter, fixtures and contract tests |
| `e4c55eb` | `e4c55eb` | `e4c55eb` (`e4c55ebb60fca3a7a58cbf94f74eae625ccd9e6b`) | 2026-11-03 | feat(integrations): Chargebee adapter, fixtures, Basic-auth webhooks |
| `a35d008` | `ecf04fe` | `ecf04fe` (`ecf04fe396203d901879cd04c63e36c1ff99ec3d`) | 2026-11-03 | feat(integrations): Slack approvals, signals and morning digest (Q-31) |
| `e3d6949` | `16565f6` | `16565f6` (`16565f6ccae5e8ff9fbf2eca9be9bf8916b80260`) | 2026-11-03 | feat(integrations): Settings › Data health (dead-letter list in plain words) |
| `c67616d` | `c0041f2` | `c0041f2` (`c0041f258dbc1f14f0c68f7663653db5c0c6a6eb`) | 2026-11-03 | feat(setup): five-step setup wizard, empty-workspace seed, demo webhook |
| `6c57cec` | `9d78861` | `9d78861` (`9d78861a98169ce37feadc896ae62524edef21ad`) | 2026-11-03 | test(e2e): M5 integrations and setup flow, a11y, secret patterns |
| `6998b08` | `1ed14c1` | `1ed14c1` (`1ed14c17873f6da75e42c42d688155eb31ba75d0`) | 2026-11-03 | fix(settings): Setup tab last so /settings still opens Users for Admins |
| `e1b1490` | `61c80e9` | `61c80e9` (`61c80e9b2288c24b5df88df69b2e990610e0df93`) | 2026-11-03 | fix(integrations): a real-time payment signal refreshes Today right away |
| `aa9f38c` | `319580c` | `319580c` (`319580c24081a24d6f20d345347df8621aa6d2a9`) | 2026-11-03 | docs(m5): M5 complete: Tier-2 pair, fresh-database demo, Session B log |
| `7dfe001` | `a0aae32` | `a0aae32` (`a0aae32d7269dae4aaadaaf2fee719728afea802`) | 2026-11-03 | fix(integrations): Slack is not read-only (Q-56) |
| `3a6110c` | `93d0fa0` | `93d0fa0` (`93d0fa01dc3418d67c9320c8c654b27efc8796f0`) | 2026-11-03 | feat(onboarding): M6 models OnboardingTemplate, Plan, Step and Goal with RLS |
| `ab41121` | `382654f` | `382654f` (`382654fafa916c7c791873f6dfdd57ac2b4cc33f`) | 2026-11-03 | feat(onboarding): time to value and stall detection, deterministic (D2, D3, D4) |
| `ae4aaa1` | `4f2c673` | `4f2c673` (`4f2c67360ae934921489ad4354b0e7eea1e1a02e`) | 2026-11-03 | feat(signals): five onboarding rules in the catalogue (D4) |
| `63a22fe` | `743af34` | `743af34` (`743af3446bd351f98e6b49b4af33d713d6a6f6e0`) | 2026-11-04 | feat(onboarding): nightly onboarding pass in the signals chunk (D1, D3, D4) |
| `77cca84` | `5382edf` | `5382edf` (`5382edf51090d243c22aa1bb3b7432ba864a2de2`) | 2026-11-04 | feat(usage): Adoption view in CS language, a new tab beside Usage (D6) |
| `9ca6417` | `9b98243` | `9b98243` (`9b9824373e1f107238b6ed2407af46b9e2b50920`) | 2026-11-04 | feat(onboarding): Sales handoff assembly with sources (M6 rule 6) |
| `1e9a2f6` | `d5e247d` | `d5e247d` (`d5e247df7ff3dc34ecdc59db04f0941d2532dfe3`) | 2026-11-04 | feat(onboarding): plans, steps and templates with screens and seed (M6 A7) |
| `af03183` | `996781e` | `996781e` (`996781e89c8dace6c93ecf7b7c9ef4db9d003e34`) | 2026-11-04 | docs(m6): Session A log, decisions D-100–D-108, questions Q-58–Q-64 |
| `34ed80b` | `1275015` | `1275015` (`1275015149ea0337da2313ed11fa5b40060e29b6`) | 2026-11-04 | feat(usage): Usage ingest API on the M5 framework (M6 B1) |
| `681293b` | `ce07ddb` | `ce07ddb` (`ce07ddb94bdc049d558251f32b2604d91367cccd`) | 2026-11-04 | feat(integrations): Mixpanel and Amplitude usage adapters and the usage cards (M6 B2) |
| `5340698` | `04ab90d` | `04ab90d` (`04ab90d4df7ad987fc26b99eced716c5025a0e7e`) | 2026-11-04 | feat(agents): Onboarding Manager and Adoption Coach, onboarding event consumers (M6 B3) |
| `407a5d0` | `24792c1` | `24792c1` (`24792c1d4dcbe2b62db1d68ed81397d17efcac8e`) | 2026-11-04 | feat(usage): demo:usage, M6 e2e and a11y specs, Adoption Coach finding on the Adoption tab (M6 B4) |
| `0d5d0d9` | `473d818` | `473d818` (`473d8185d1eca8cd692c381e5b8b45fa7d6bdfdd`) | 2026-11-04 | test(e2e): the M6 reset also forgets the Usage API's learned account mappings |
| `6358eae` | `cadc2f5` | `cadc2f5` (`cadc2f535a30f885e084e9daa2faf22449a588d4`) | 2026-11-04 | docs(m6): Session B log, acceptance table, decisions D-109–D-115, questions Q-65–Q-68, changelog, plan checkbox |
| `ba63b36` | `44250b6` | `44250b6` (`44250b63229eb46dfe4c85916fd42426891b0e45`) | 2026-11-04 | docs: independent review of M4–M6 (2026-11-04) |
| `2d2d11e` | `a327d7f` | `a327d7f` (`a327d7fcfe2aec2c7dd5eeffd238946eca18a2bb`) | 2026-11-04 | fix(usage): raw usage events leave Redis with their job (review S1) |
| `571a471` | `0a79847` | `0a79847` (`0a798479e0ec458098d44c9e0684e90e07acfe57`) | 2026-11-04 | test(tenancy): UsageIngestBatch joins the M6 attack suite (review S2) |
| `a7d46cb` | `85f1706` | `85f1706` (`85f1706ad08d94ba0e462a5fe8ea323cac16c152`) | 2026-11-04 | fix(integrations): write-back refuses a live transport without WRITE_BACK_LIVE (review S5, D-116) |
| `2e40c85` | `c2d7ca8` | `c2d7ca8` (`c2d7ca89dbe86e407ecadddae505596c555b8b28`) | 2026-11-04 | test(jobs): the outbox test claims only its own workspace's events (Q-68) |
| `618ff81` | `2ef8ad3` | `2ef8ad3` (`2ef8ad385999ae743ff99a28de8bec5c6bd2ad63`) | 2026-11-04 | test(e2e): M5 screenshots stop rewriting tracked evidence images (review N1) |
| `326a0cf` | `0e0181e` | `0e0181e` (`0e0181e1b25339f10f8d376bdd7f2afb71c7d620`) | 2026-11-04 | docs: post-M6 review fix log, D-116/D-117, Q-65/Q-68 recorded, deferrals homed in M8/M9/M12 |
| `ccae4d7` | `be75171` | `be75171` (`be75171b9322e5d9356b5670b6cd6b6810b88287`) | 2026-11-04 | feat(renewals): M7 models Renewal, RenewalOutcome, ExpansionOpportunity, Document with RLS (M7 A1) |
| `a500ade` | `ff9a5ba` | `ff9a5ba` (`ff9a5baea6bcd950f765bae9f07f62936a40df53`) | 2026-11-04 | feat(renewals): deterministic renewal confidence, champion state, as-of risk signals (M7 A2) |
| `f323b7a` | `d5783ff` | `d5783ff` (`d5783ff352560fd68e76b5188b239251dc45bd83`) | 2026-11-04 | feat(renewals): confidence back-test on the seeded history, simple model ships (M7 A3) |
| `d95c3fb` | `7a588f8` | `7a588f8` (`7a588f8c4947f7f00bb918641c92a7cf6f370290`) | 2026-11-04 | docs(m7): Session A log (stopped at A3), back-test results, D-118/D-119 |
| `ee2b94f` | `a6820fc` | `a6820fc` (`a6820fcc035be561fc3c2c4fe15b83aa0c274e83`) | 2026-11-04 | feat(renewals): renewals.sync in the nightly score chunk, outcomes from contract records (M7 A4) |
| `513602d` | `386ae40` | `386ae40` (`386ae409643e007df746a18513cb59c8badb0c2d`) | 2026-11-04 | docs(m7): Session A stopped after A4: Northgate ties at 70 with six renewals; D-120 |
| `383ff9f` | `264d99e` | `264d99e` (`264d99e5e8e5f0f6325f21a38f75621f69b5acaa`) | 2026-11-04 | docs(m7): Northgate demo asserts the seven-way tie, not 38% LOW (D-120 correction) |
| `068454a` | `8ab1968` | `8ab1968` (`8ab1968128f9b63c57269850653216a37cdfec4f`) | 2026-11-04 | feat(renewals): renewal radar, audited forecast category, Account 360 renewal tab, shared money redaction (M7 A5) |
| `b8fa34e` | `5eb2bac` | `5eb2bac` (`5eb2bac2dc9622982503a72faacc988fa94cd6a4`) | 2026-11-04 | feat(revenue): ARR waterfall reconciling to the minor unit, contract cross-check as data-quality items, billing forecast (M7 A6) |
| `0b467eb` | `7aa36eb` | `7aa36eb` (`7aa36eb37bf37ecffdd4a5aa6b577e8861b888bf`) | 2026-11-04 | feat(revenue): money at risk, coverage, team load, /revenue behind revenue access, M7 e2e (M7 A7) |
| `75a78c2` | `850f0ae` | `850f0ae` (`850f0aebf7f14c26d6a64692041dfd135059dd5a`) | 2026-11-04 | docs(m7): Session A complete: A5–A7 log, mid-milestone full run, D-121, Session B state |
| `d051337` | `942292a` | `942292a` (`942292ab1bbf33e19b0098fd68e31e6dbc4b7d9c`) | 2026-11-04 | feat(signals): expansion rules: credits near limit, new team, fast growth, stated seats goal (M7 B1) |
| `5200394` | `3114592` | `3114592` (`3114592942ca262e3918dae863bf19ff9e5a48e1`) | 2026-11-04 | feat(expansion): estimate from the account's own price, opportunities, whitespace, /expansion, CRM export via the write-back gate (M7 B2) |
| `0ad989b` | `72bfc02` | `72bfc02` (`72bfc02877498e1781fe0b4cee7a6d4fe14217df`) | 2026-11-04 | feat(documents,agents): locked-metric documents, placeholder validator, renewal-manager, Renewal Brief (M7 B3) |
| `4d06cdd` | `533c135` | `533c135` (`533c13511b3d6ad67b5a9787b943e29f41353a08`) | 2026-11-04 | feat(agents): expansion-finder: usage-and-limit note and proof-led draft to Approvals (M7 B4) |
| `7e5d450` | `ae3a2e3` | `ae3a2e3` (`ae3a2e3bc194d3e12683eee993c64c97c30e6579`) | 2026-11-04 | feat(outcomes): revenue checkpoint statuses renewed/expanded/contracted/churned with attributed value (M7 B5) |
| `13d6151` | `a5d9a7c` | `a5d9a7c` (`a5d9a7ca66201daaf67307d4e1d4ab401b740101`) | 2026-11-04 | test(e2e): M7 brief, approval, expansion, outcome steps; a11y-m7; recorded renewal agents (M7 B6) |
| `3b99c4a` | `74699dd` | `74699dd` (`74699dd85ad78052173b6b1b07cc74f5c1fd3e3b`) | 2026-11-04 | docs(m7): D-122..D-127, Q-69..Q-72, demo text and commands for Session B |
| `443c8c9` | `beb68dd` | `beb68dd` (`beb68dd1afc73cf556a6b724fd18ca6ae9daad9d`) | 2026-11-04 | test(e2e): M7 outcome step uses a far-out renewal and tolerates a re-run |
| `18985cb` | `1fe0337` | `1fe0337` (`1fe0337d5f8f77037afe69c3f1452fd749677afd`) | 2026-11-04 | docs(m7): milestone complete: acceptance table, regression statement, decisions, deferrals, CHANGELOG, plan checkbox |
| `3bdeb08` | `71c6df7` | `71c6df7` (`71c6df7185c709a2b8ac9eefae3543f14ab72fc9`) | 2026-11-04 | feat(tasks): link Task to Signal via composite FK and mark ACTED on completion (Q-48) |
| `ee4429c` | `d92b7bf` | `d92b7bf` (`d92b7bf4535e28c3a08c3d90704f3c0e200e033f`) | 2026-11-04 | feat(plays): add Play, PlayVersion, PlayRun, PlayStepRun models, backlog migration, and tenant isolation tests |
| `4fad4ed` | `fa143cb` | `fa143cb` (`fa143cbfa05cb66f958e3a353d5da44943183e8e`) | 2026-11-04 | feat(plays): add PlayDefinition Zod schema, pre-publish safety gate, and publish service |
| `436e259` | `1a86f55` | `1a86f55` (`1a86f551430a35edf4351786d8de841bb8cf9784`) | 2026-11-04 | feat(plays): add step-level approval resolver, runtime cap check, outbox fan-out, approval.decided and note.created |
| `23804fc` | `dfaaa59` | `dfaaa59` (`dfaaa593ac526c3e71fefe19c34c959868a16c71`) | 2026-11-04 | feat(plays): add play runner, step handlers, approval wait/resume, stall sweep, and dispatch proof |
| `3fe1960` | `7a852cb` | `7a852cb` (`7a852cb47919a844b3a5e2792f90421464ee671b`) | 2026-11-04 | feat(plays): admin auto-send master switch with typed confirmation, audit, and guard integration |
| `776f769` | `3f76062` | `3f76062` (`3f760620ee7574263b0397abd0a66701421f65ac`) | 2026-11-04 | feat(plays): seed 15 plays with 11 live and 4 dormant naming future milestone detectors |
| `7104a12` | `3556463` | `3556463` (`3556463693d06dc36e7bc823049ca5b0584658eb`) | 2026-11-04 | feat(plays): /plays list, inspect, duplicate, publish/pause/kill, versions, and retroactive entry |
| `53ed8c4` | `b6eb183` | `b6eb183` (`b6eb18393bc094e72c7bd0428bc976d8748708e3`) | 2026-11-04 | fix(agents): safely validate signalId before attaching to Task in renewal-manager and onboarding-manager |
| `0ca171f` | `6f50206` | `6f50206` (`6f502068dfc457424ba68d0bb597e192d2d85df8`) | 2026-11-04 | docs(m8): Session 1 complete: slices S1-S8, D-128..D-139, full test run, Session 2 state |
| `0655b8a` | `f47f8da` | `f47f8da` (`f47f8daa833b8aa7dd7a97e60784d163eef5d56c`) | 2026-11-04 | feat(agents): extend outreach agent with voice samples and add digital-csm agent with hand-off rules |
| `e239035` | `01a423d` | `01a423d` (`01a423de780118e12f9699cec49185032519a56e`) | 2026-11-04 | feat(plays): play-builder agent saving as DRAFT and facing safety gate (D-138) |
| `f75cec0` | `10ddbaf` | `10ddbaf` (`10ddbaf3e8496acca038d74d8e48fecaba530d5a`) | 2026-11-04 | feat(plays): play results screens, dead-play detection, and cancellation note tag consumer |
| `624ec75` | `02e7f07` | `02e7f07` (`02e7f07cc9460e1e9658eea091d291220b843fe2`) | 2026-11-04 | feat(renewals): human plan adoption into Renewal.planSteps with placeholder validation |
| `61e364a` | `9cc2c86` | `9cc2c86` (`9cc2c8658db31dd756fef057ac224c3e477bdf40`) | 2026-11-04 | feat(campaigns): campaign schema, campaign approval, and dispatch campaign mode |
| `9f4c8e9` | `ab5ecf8` | `ba9a4d9` (`ba9a4d9145a2171482ed3b533db629fd676c6b07`) | 2026-11-04 | feat(campaigns): campaign editor, pacing, unsubscribe route, and webhook receiver |
| `32b7d69` | `0176b4f` | `9ac9522` (`9ac9522ed1a6f4ca7b78bad93ee74543cbd1814a`) | 2026-11-04 | feat(setup): proposed plays step with deterministic proposal rules |
| `f14daa3` | `8a972d0` | `a3073a7` (`a3073a7094ebc5db42a26179d141fe42a52604b4`) | 2026-11-04 | feat(plays): e2e specs, a11y tests, navigation gating to M8 |
| `27533f9` | `4e19ad7` | `8ba9e81` (`8ba9e81dff1f94e0a861468b3922018710f9e604`) | 2026-11-04 | demo(m8): fresh scratch database end-to-end verification script |
| `cbfb5d4` | `29fc6d8` | `1e3ee33` (`1e3ee33ba244d2ced72104e8a1830969c588e69e`) | 2026-11-04 | fix(m8): resolve e2e selectors, a11y color contrast, and add Textarea component |
| `a1be50d` | `dd22ed3` | `f85ea35` (`f85ea35c7c4f989b99b5b98c5ce0758c839691b7`) | 2026-11-04 | fix(tasks): rebuild workspace today cache when escalating tasks |
| `712d626` | `848c3b3` | `76325a5` (`76325a5205990e11a731153c1ab95657b76f5852`) | 2026-11-04 | fix(m8): resolve module boundary imports, type definitions, and demo helpers |
| `9281767` | `65e23a0` | `e1b2ca7` (`e1b2ca7e16aca1bebca52a9e7fe69c42ed04453a`) | 2026-11-04 | fix(campaigns): campaign approval message and inbound message lookup across tenants |
| `9bce218` | `6f31dc8` | `09864ee` (`09864ee5fe98c4d05f92ca698899ceb81315a070`) | 2026-11-04 | docs(m8): milestone complete |
| `7c45c4b` | `a1db862` | `3b5ffde` (`3b5ffde0f1548645577eb0205a78dcbc2e602bc6`) | 2026-11-04 | feat(m9): schema for promises, inbox, unmatched mail and extraction chunks (A1) |
| `270c4d2` | `9c8f5db` | `734c43f` (`734c43f7366793ee0349218227ae88b31a7571fe`) | 2026-11-04 | feat(m9): transcript chunker, who-promised, theme list, per-kind goldens (A2) |
| `64a3ad3` | `979cfc3` | `9bb15b2` (`9bb15b2ff078cb5eb52006302a2b0fa64567ea1a`) | 2026-11-04 | feat(m9): full Watcher — transcript chunks, both directions, reextract and sweep jobs (A3) |
| `e772763` | `905d51e` | `17a879e` (`17a879effc3903d1fcb86a61aee941c279cc11e1`) | 2026-11-04 | feat(m9): promise engine — status by code, promises and AI goals from extractions, promise rules (A4) |
| `e6749a7` | `8df1de2` | `d4c8545` (`d4c8545f551a17eb295ae490384189c5d8c497ec`) | 2026-11-04 | feat(m9): text signal rules with verified-quote evidence (A5) |
| `78893fb` | `aef5b6a` | `70456b4` (`70456b49574e9074b608baf54cf29d8286ab5c9e`) | 2026-11-04 | feat(m9): people signal rules; championState moved to health (A6) |
| `8f8df73` | `da12259` | `e03f4d3` (`e03f4d39c5683537dd9a1b4232490495b8674ae7`) | 2026-11-04 | feat(m9): inbox matching, Unmatched queue, intake and inbox sync (A7) |
| `9e1b900` | `08d53eb` | `07379ad` (`07379add5be58c615b68932568e2e05aed2922c4`) | 2026-11-04 | feat(m9): seed story data through the real Watcher, inbox and Unmatched example (A8) |
| `3985165` | `424e892` | `bdae7be` (`bdae7bec44b19897a1939ce4b954d984d6ca7124`) | 2026-11-04 | fix(m9): keep M9 rules out of the renewal back-test; docs for Session A (D-140–D-146, Q-66–Q-70, M9-LOG) |
| `80a3269` | `7e1bdc6` | `c91a3a7` (`c91a3a7fc7a0adac9e4b900aeb58a0fa32d025eb`) | 2026-11-04 | feat(m9): wake Promise Late, relabel Engagement Loss, seed.int sentiment count; renumber M9 questions Q-73–Q-77 |
| `503946a` | `53f5f55` | `6be3771` (`6be3771de9ed961e0fa2ca9f429237b9b70ad801`) | 2026-11-04 | feat(m9): /inbox, Unmatched queue UI, Account 360 conversation labels read from Extraction (B1) |
| `20a6ba2` | `132455c` | `a4b2df3` (`a4b2df3f49a4fb017c926cac2dfe17e456fb2a54`) | 2026-11-04 | feat(m9): Support Risk Agent and inbox reply drafts through Approvals (B2) |
| `9f5e079` | `eec737e` | `a9be59d` (`a9be59dba85e2d110ca8296da9a6b77284cde9b2`) | 2026-11-04 | feat(m9): promise surfaces — tracker, account tab, Promise Keeper, handoff promises, brief promise metric (B3) |
| `138c1a2` | `0b7d81c` | `0051ff5` (`0051ff578c14906634f4144a03f95f25560e5bda`) | 2026-11-04 | feat(m9): Champion Guard — ranked candidates by code, intro draft through Approvals, People-tab card (B4) |
| `e13b7a9` | `fafb9ac` | `bcc2dc6` (`bcc2dc6f855a9f388bd8436718430123e67243e4`) | 2026-11-04 | feat(m9): Sentiment & themes — portfolio view and account panel, quotes with source links, no N+1 (B5) |
| `642a080` | `77e02b7` | `48f7323` (`48f73232c8e5ca5e754f8af94d113c8a08756781`) | 2026-11-04 | feat(m9): navigation (Inbox, Promises), SHIPPED_MILESTONE 9, M9 e2e and axe specs (B8) |
| `43806df` | `cae881b` | `1983792` (`1983792b14f6674e531b0cc20665da7705702ee7`) | 2026-11-05 | feat(m9): fresh-database demo scripts and recorded output (B9 prep) |
| `729bc63` | `b663cd7` | `36d9126` (`36d9126d97750535c8658d19b0db86b13cd91305`) | 2026-11-05 | fix(m9): Brightwell seed item is a theme not a complaint; M7 e2e expectations (D9); M9 e2e sent-count check |
| `bd5d39a` | `5f027f5` | `fe8c348` (`fe8c348d6756a692fcda41e779a773809d377e51`) | 2026-11-05 | fix(m9): UTC title-change stamp; seed-m9 checks robust to a shared database |
| `98c8d0d` | `b525e0b` | `a1b54e8` (`a1b54e8e0d7be2d1da3af8d00f107f2c65a08be7`) | 2026-11-05 | docs(m9): Session B close — log, acceptance table, decisions, questions, changelog; demo script reads credentials from env |
| `da1f933` | `2c2b470` | `4f16e5d` (`4f16e5d6c5f488d58f77493c095ab0d814b197f2`) | 2026-11-05 | fix(security): Q-78 scanner pattern for DB password shape and rotate local DB passwords |
| `7b93e1b` | `417c270` | `d32a052` (`d32a0523f12ea07020bc4096ee047d7c76d21b01`) | 2026-11-05 | feat(integrations): Zendesk and Freshdesk adapters with contract tests (B6) |
| `38f9a70` | `cd83d10` | `9e14492` (`9e144922976e542415924933476c8d13c41a13a3`) | 2026-11-05 | feat(integrations): Gmail and Microsoft Graph adapters with privacy filter (B7) |
| `8e77989` | `532b7f5` | `1543daa` (`1543daa64d11f1f40e9a3f9b234615888a306d01`) | 2026-11-05 | docs(milestone): complete Milestone M9 with close log, changelog, and plan update |
| `78b0376` | `b6bc84b` | `e7ca7a1` (`e7ca7a1e515e02c840cb46af94c22681a8a773ea`) | 2026-11-05 | docs: independent review of M7–M9 (2026-11-05) |
| `24dea13` | `c1e7ff4` | `d47e073` (`d47e073f6908a9ae8dd03068f5ca166246d9d436`) | 2026-11-05 | fix: post-M9 review fixes (S1-S4, N1) |
| `0231f6d` | `0548e3f` | `69764ac` (`69764ac735493d99c5a4bcd3385f89c466d410f6`) | 2026-11-05 | feat(m10): session 1 — meetings, briefs, summaries, adapters & signal wake (slices 1-6) |
| `9777818` | `afb5801` | `602da69` (`602da697b20178f63a41094ce9b35f5d78fee79e`) | 2026-11-05 | feat(m10): complete meetings, qbrs, success plans, customer portal and surveys |
| `ead64ac` | `9cb1579` | `6d303b6` (`6d303b63d644cca2ea0a00597c7ab731c2a9836e`) | 2026-11-05 | feat(m11): S1 schema — ReportSnapshot, AskThread/AskMessage, frozen checkpoints, live-snapshot guard |
| `faeb050` | `74418d8` | `f18980b` (`f18980b25b3f2d232c2055b76ed4613632414612`) | 2026-11-05 | feat(outcomes): S2 frozen 30/90-day checkpoints, alarm class, seeded history and backfill |
| `716e17c` | `33f16db` | `825eecf` (`825eecf3436ea3818419be99ae8ca17c663ae233`) | 2026-11-05 | feat(outcomes): S3 ledger math — cohort, saves per Q-15, groupings, redaction |
| `789859b` | `ad8ddd9` | `ccdcfef` (`ccdcfef50a3969c766d3d024919325e238972eec`) | 2026-11-05 | feat(outcomes): S4 Outcome Ledger screens, save record, Account 360 tab, play results link |
| `5559be1` | `d17d548` | `c2558b2` (`c2558b256a7791abd84c6d434f7d40d365a96682`) | 2026-11-05 | feat(outcomes): S5 AI accuracy view with cries-wolf list and audited Tune/Kill |
| `c23c630` | `f716856` | `002785a` (`002785a9b66e4eda9486ce787426791a3655afd1`) | 2026-11-05 | feat(reports): S6 seven pre-made reports as immutable snapshots with record links |
| `247654d` | `4d0253d` | `9bc3772` (`9bc3772c0545477ad9be2afc291baee41b770569`) | 2026-11-05 | fix(outcomes): judge AI accuracy by the 90-day check date, as the ledger does |
| `ac60774` | `cc3258a` | `fee1d16` (`fee1d1668c663722001335308ffe3592d698d7cb`) | 2026-11-05 | feat(reports): S7 Leader Reporter weekly digest — cited, money-free, internal only |
| `d9931bc` | `afd90a3` | `8607240` (`8607240bbcc97a618314f3fbdbc142851e225dce`) | 2026-11-05 | fix(agents): build the agent registry on first use (import-cycle safe) |
| `751c2f7` | `b7609c5` | `ff0dc18` (`ff0dc1806f099e39db3ec21a8d68c01df09016e4`) | 2026-11-05 | docs(m11): Session 1 log draft — slices S1–S7, mid-run, seed proof, findings, Session 2 state |
| `1c276cc` | `06649f4` | `1cab5c9` (`1cab5c936b8288a9f3f701109d76e71a1911b516`) | 2026-11-05 | chore(lint): fix 23 of the 28 lint errors left in M10 files (lint-only, no behaviour change) |
| `aa5af73` | `4bacd92` | `629c73c` (`629c73c802405853a9f2a8a1fb5c6a0c1c932e25`) | 2026-11-05 | refactor(db): portal and survey token access through src/lib/db; no hard-coded survey secret |
| `615eccc` | `b48dcf1` | `feb0b6b` (`feb0b6baf554ddf29ba3bdc6e1e0f5988d544711`) | 2026-11-05 | feat(ask-ai): S8 scoped read tools — Ask AI runs as the asking user |
| `1874708` | `5f4be94` | `442c1b0` (`442c1b020ccdf908981fe876a479946f8daa02f4`) | 2026-11-05 | feat(approvals): S9 change-list approvals — Ask AI proposes, a human approves, services execute |
| `3484a29` | `2e06589` | `ee17d9a` (`ee17d9adb403bcb9d65bb6f460719b45bb824f10`) | 2026-11-05 | feat(ask-ai): S10 Ask AI agent — code-driven tool loop, cited answers, proposals only |
| `cf16b73` | `a55577c` | `dbc0f83` (`dbc0f83e60f0965597792ae015a045982e0552c2`) | 2026-11-05 | feat(demo): M11 live save chain on Harborwood with a demo-only business clock |
| `0e0ad22` | `0b9d8d9` | `5694000` (`5694000314007aad6ae7af5ef406ab91e26ea49e`) | 2026-11-05 | feat(demo): recorded Ask AI answers composed from tool records; Renewal Risk demo publish |
| `7fb5350` | `56a9c48` | `c353334` (`c3533346204d0975d5bccfa611685030870a0f70`) | 2026-11-06 | feat(ask-ai): S11 /ask screen, file Q&A behind the scan gate, Approval confirmation card |
| `bae5599` | `280d69c` | `424945a` (`424945a5e949b47dcdaa93487d7ad2660beb10e1`) | 2026-11-06 | feat(settings): S12 voice dictation setting (off by default) and Reports / Ask AI in the nav |
| `f910185` | `67800dc` | `fa9c91a` (`fa9c91a78167adbbcd9a8e3d2221dcff7d428e08`) | 2026-11-06 | feat(demo): recorded Ask AI answers over an attached file; demo contract-terms PDF |
| `018ca27` | `d653861` | `92f3d70` (`92f3d702557ff47b0af219cd929c06cc13a01f73`) | 2026-11-06 | test(e2e): S13 M11 Ask AI, ledger, reports, digest and voice flows; axe on new screens |
| `28acf79` | `6a8de21` | `9fd120b` (`9fd120b5456c66e86c018c20f03d0033cc9beb69`) | 2026-11-06 | fix(demo): scope the save-chain demo's checkpoint passes to Harborwood |
| `74013b7` | `1d03de6` | `96a2386` (`96a23866bd72c955057ba6ea8db3ad6bccfb4517`) | 2026-11-06 | docs(m11): clock-forward demo evidence on a clean dev seed (Harborwood save chain) |
| `837c9dc` | `8e342d2` | `468afb6` (`468afb6040777d470a923045e3ec722d759fa90e`) | 2026-11-06 | docs: Q-86 founder decision on Brightwell's M10 figures (64.87 / WATCH / 40) |
| `0cf13ea` | `25689e5` | `18e747a` (`18e747adb4988580fc76e3e2390bfad099cd6e0a`) | 2026-11-06 | fix(e2e): M11 save chain on an account outside the radar; manual digest trigger id |
| `f8ecb23` | `9dbb39e` | `2496ac5` (`2496ac51fb79b0385562f9f0d4cf23f0e0a805c0`) | 2026-11-06 | docs(milestone): complete Milestone M11 — log, acceptance table, M12 hand-off, changelog |
| `482684c` | `6966b6b` | `d81e930` (`d81e93069ac06a021036b22dc869a4681a04282e`) | 2026-11-06 | chore(security): full-history secret scanner; scanner rules for fallback defaults and URL templates |

## M12 Session A commits made between the two passes (13)

| Before 2nd pass | Final | Date | Subject |
|---|---|---|---|
| `b47a87d` | `dc792cf` (`dc792cf5edba165cfb31fffa13a9d6c375ba5fa7`) | 2026-11-06 | chore(security): M12 A2 history scrub verified — hash map, scan evidence, D-172 |
| `ad9f7ad` | `fe55681` (`fe55681fc844b69450b1532157ce494a4e148546`) | 2026-11-06 | fix(db): M12 A3 reconcile schema to the migration folder; from-zero proof (D-173) |
| `8a61cc3` | `80ecb6e` (`80ecb6ededa4cdd839d8a369710a612f31d09912`) | 2026-11-06 | docs(m12): A1 deferral sweep (37 rows, every item placed) and M10/M11 errata |
| `a39f176` | `724f74a` (`724f74a4940e34d795b3914036b54b18880604cd`) | 2026-11-06 | fix(db): M12 A4 M3 stamp triggers write UTC (Q-81) |
| `5f60ab3` | `ab56b6c` (`ab56b6c427190a70c820a8b5b5ef66d3dc266a35`) | 2026-11-06 | fix(db): M12 A5 scoped operations inside a tenant transaction run on its connection (Q-54) |
| `0e0facb` | `cb76e02` (`cb76e0280b59550a366fc8b7cd943bd24416d6b2`) | 2026-11-06 | test(auth): M12 A7 RBAC full matrix and revenue redaction across financial projections |
| `ca7b8fd` | `72dca07` (`72dca07f3d17efcb2384929f18756d82782b6722`) | 2026-11-06 | test(db): M12 A6 tenant enumeration over every Server Action, Route Handler and Ask AI tool (Q-50) |
| `b997666` | `8b6eb70` (`8b6eb70dec62181996bd65534db86553aaf46244`) | 2026-11-06 | feat(security): M12 A8 CSP with per-request nonce, security headers, cookie flags (D-175) |
| `6079215` | `7d43b56` (`7d43b5645dac083cec1fed5f35c402b6176ee77e`) | 2026-11-06 | feat(security): M12 A9 repeated-401 IP block, endpoint rate limits, streaming body caps (D-176) |
| `df63bf8` | `e5d8e19` (`e5d8e195deb48af7d7955d6b8c8424279ac67755`) | 2026-11-06 | fix(surveys): M12 A10 public survey route, hardened survey tokens, unsubscribe fallback removed |
| `64e158d` | `d112e0c` (`d112e0c29851c01d3eef138d6adde7475cbbff5a`) | 2026-11-06 | feat(security): M12 A11 deep log redaction, CI with full-history secret scan, dependency audit |
| `e11e133` | `483e739` (`483e7391979126ab2875e4047e011e35bf35630f`) | 2026-11-06 | test(ai): M12 A12 prompt-bundle isolation across every agent; SECURITY.md with Q-19 terms |
| `8fb0ff8` | `e2f1e42` (`e2f1e429b2714fc59dba68dd9e1084ed7547e07e`) | 2026-11-06 | docs(security): rate limits and body caps in SECURITY.md (D-176) |
