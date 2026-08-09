# 23b — W1's mobile twin: a highlight job per streamed delta, each retained 5 minutes

Status: **filed, not started.** Wave 2 fixed the web half (W1); this records the mobile
half so it is a decision rather than an oversight.

## What W1 fixed on web

`apps/web/src/turbo/streamingCodeBlock.tsx`: a streaming code fence used to be re-tokenized
by Shiki from the top on every delta. It now shows a placeholder inside the code-block frame
while `isStreaming` is true and gets exactly one coloured render when the message completes.

## The same shape exists on mobile, and is worse

`apps/mobile/src/features/threads/markdownCodeHighlightState.ts`.

`createMarkdownCodeHighlightAtomFamily` keys an `Atom.family` on a
`MarkdownCodeHighlightCacheKey` built from `Data.Class<{ code, enabled, language, theme }>` —
i.e. **the whole code string is part of the cache key**. `useMarkdownCodeHighlight` constructs
that key from `input.code` on every render.

So while a fence streams:

1. Every delta produces a different `code`, therefore a different key, therefore a **new atom**
   with a **new `Effect.tryPromise` highlight job**. A 300-delta fence is 300 Shiki runs, not one.
2. Each of those atoms carries `Atom.setIdleTTL(MARKDOWN_CODE_HIGHLIGHT_IDLE_TTL_MS)` = **5
   minutes**. Every intermediate prefix of the fence is therefore retained, with its token array,
   for five minutes after it stops being observed — on the memory-tightest surface in the product.
   The retained set is O(deltas) strings plus O(deltas) token arrays, and the strings are prefixes
   of each other, so the total is quadratic in the fence length.
3. `Data.Class` equality is structural, so each key comparison walks the full code string too.

The web fix is not portable as-is: mobile has no equivalent placeholder component, and its
highlighter is `shikiReviewHighlighter`, not the web Shiki path.

## Sketch of the fix (to be designed properly when this is picked up)

- Gate on the message's `streaming` flag the way web now can — Wave 2's reducer change
  (`clearStreamingForTurn` in `packages/client-runtime/src/state/threadReducer.ts`) makes that
  flag trustworthy on mobile too, since mobile reads the same store. While streaming, skip the
  highlight entirely and render plain monospace text; highlight once on completion.
- If a live highlight is wanted anyway, the cache key must stop being the code string — key on
  `(messageId, language, theme)` and let the atom re-run on code change — and the idle TTL must
  be far shorter for streaming keys than the 5 minutes a settled block deserves.
- Whatever ships needs a test that pins "N deltas produce one highlight job", the mobile
  equivalent of the web module's placeholder tests.

## Why it is filed rather than done in Wave 2

Wave 2's scope was the four surfaces the audit measured, and the mobile app was not among the
measured ones. The change above needs a mobile-side design decision (plain text while streaming
vs. a mobile placeholder) that is a product call, not a mechanical port. Filing it keeps the
asymmetry visible: after Wave 2, web streams code cheaply and mobile does not.
