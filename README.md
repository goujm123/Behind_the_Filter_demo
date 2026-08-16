# Behind the Filter

Bilingual browser ARG and Media and Information Literacy investigation game.

## Playable build

Open [`behind-the-filter.html`](./behind-the-filter.html) directly in a browser. The build is an offline bundle with no network dependencies. Keep the `materials/` directory beside the HTML file so local sound, archive, and ending media remain available.

Current milestone: Case 001 scenes P00-P09 are playable from opening through evidence analysis, final recommendation, branch consequence, and case closure.

Media included in the offline bundle: interface sound effects, the P05 archive recording, and three P08 branch consequence videos. Submitting a recommendation opens its consequence video in a separate TRACE playback window and attempts playback at 25% volume. Browsers that block audible autoplay fall back to muted playback with an on-screen unmute control.

The files `trace-arg.html` and `trace-behind-the-filter-combined.html` are preserved as team drafts and visual references. Continue implementation in `behind-the-filter.html`.

## Verification

Run the Chrome smoke test from the repository root. It covers v1/v2-to-v3 migration, P00-P09 progression, evidence marking and connections, all three decisions, media paths, bilingual rendering, persistence, reset, and responsive screenshots:

```powershell
node tests/smoke.mjs
```
