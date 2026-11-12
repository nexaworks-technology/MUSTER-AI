# Ask AI redesign, Claude pattern (2026-11-12)

Scope: the `/ask` conversation area only. Presentation only: the Ask engine (retrieval, citations,
guards, budgets, run behaviour), the app shell, the glass system and every other screen are unchanged.
Reference: `docs/design/reference-ask-claude.png` (supplied by the founder in chat during this session;
the file did not exist in the repo at first, so the work stopped until it arrived, then it was saved there).

**Result: PARTIAL.** Everything asked for is built and verified except one e2e that already failed
before this change (below), and two deliberate departures from the brief's wording (inline expander,
exact terracotta value).

## What changed

| Brief item | Done |
|---|---|
| 1 Layout | One centred reading column (max 760 px) on a warm paper panel; the thread list is a plain text list (no cards, no borders) with a quiet hover wash and the open thread marked (`aria-current`). |
| 2 Answers as text | Flowing text on the page, no card, border or bubble, headed by an original 8-point starburst mark (inline SVG, terracotta) and the `PRODUCT_NAME` constant as a quiet byline. |
| 3 User messages | One soft warm-grey rounded bubble, right-aligned. |
| 4 Trust elements | Numbered light pills for exactly the cited records; one caption (confidence line, wording unchanged); "What it read" as a quiet row with a chevron; Ask proposals keep a card, restyled warm and minimal, same Yes / No behaviour and test ids. |
| 5 Composer | Floating rounded box at the bottom of the column, soft shadow, attach (paperclip) on the left, circular terracotta send button on the right, grows with its text (to about ten lines). Enter asks, Shift+Enter adds a line. Loading is a quiet line with the pulsing mark ("Reading your records…"), no spinner (reduced motion: no pulse). Empty state: a short list of quiet text rows under "Try asking"; clicking one fills the box, nothing is sent. |
| 6 Thread-title bug | Root-caused and fixed (below). |
| 7 Themes | Light is the reference (warm paper tint inside the conversation area). Dark keeps the same layout with a warm-dark paper and the terracotta accent. New `--ask-*` tokens in both themes, contrast-tested. |

## The clipped thread title: root cause

Stored titles were missing their first letter ("hich accounts are at risk and why?"). The database
shows the stored **question itself** lacked the "W", so the character was lost in the browser before
submit, not in a title slice or in CSS. The question box was a *controlled* textarea; React resets a
controlled field to its state (empty) when it hydrates, wiping anything typed while the page's scripts
were still loading (slow connection, such as the tunnel, plus a quick typist). Fix: the box is now
uncontrolled (dictation and starter rows write to it through a ref). Regression test
`e2e/ask-redesign.spec.ts` holds every script chunk back for 2.5 s, types the question into the
un-hydrated form, waits for hydration, and asserts the text is intact. It failed first (empty box),
then passed.

## Deviations and things to know

1. **"What it read" is a chevron link, not an inline expander.** It still goes to the run page
   (`/agent-runs/<id>`), as before. An inline expander would need the run's inputs on the thread
   view, which is an engine/service change, and the existing e2e contract is the link.
2. **Terracotta is slightly deeper than #D97757** (`oklch(0.64 0.14 40)` light): at #D97757 the send
   arrow and the mark fell just under the 3:1 graphics contrast on the paper tint. The family is the
   same; one token to change. The "Yes, do it" button uses a darker terracotta because axe measured
   white text on the accent at 3.45:1 (fixed, with a test).
3. The byline is the `PRODUCT_NAME` constant ("NexaWorks AI CSM"); the reference mock says "Muster AI".
4. **New starter copy:** the three "Try asking" questions are new text (they only fill the box). They
   are questions Ask already answers (portfolio health, competitor mentions, and the box's existing
   placeholder).
5. Enter-to-ask is new behaviour (Claude pattern); it submits the same form, same action.
6. Not visually exercised in a screenshot: the loading line (a real answer is too quick to catch).

## Verification (production build, recorded AI)

- `pnpm typecheck`, eslint on the touched code: clean.
- Vitest `theme-tokens`: 96 passed (new `ask-*` pairs in both themes: text 4.5:1, graphics 3:1).
- a11y suites (26 tests): **light 26/26, dark 26/26.** The first run found one real violation (the
  "Yes, do it" button, above); fixed and re-run.
- `e2e/ask-redesign.spec.ts` (new): hydration regression; light and dark structure checks (centred
  column, thread list not a card, answer has no background, border or shadow, byline mark, bubble
  right-aligned, numbered pills, one confidence caption, chevron link to the run, circular send
  button, composer grows); empty-state starter rows. All passed.
- `e2e/m11-ask-ledger.spec.ts` (recorded Ask: sources, what it read, Yes-then-execute proposal,
  privacy between users, voice off): 3 of 4 passed in the main (recorded AI) run; the AI-off run
  passed. The Design 3.0 specs (Today and Ask, all 17 screens) still pass.
- **Failing, pre-existing and not caused by this change:** `m11-ask-ledger` "Dana attaches the
  contract PDF" (`POST /api/ask/files` returns 500 in the e2e environment). It fails the same way on
  the commit before this change (`f0af801`, verified with the work stashed). The browser does send
  the upload; the error is on the server. The cause was not found here; the attach button's change
  handler is unchanged, so this UI path has **not** been proven end to end.
- Not run: the full `pnpm gate` and the full e2e suite.

## Screenshots (1280 x 800, Dana, a real answered thread with a citation)

`docs/design/ask-claude-light.png`, `docs/design/ask-claude-dark.png`
