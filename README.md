# Behind the Filter

Bilingual browser ARG and Media and Information Literacy investigation game.

## Playable build

Open [`behind-the-filter.html`](./behind-the-filter.html) directly in a browser. The build is a self-contained, offline HTML file with no server or external assets required.

Current milestone: Case 001 scenes P00-P06 (opening sequence, case homepage, urgent mail, viral post, fixed-query search, university archive, and source trace). P07 is unlocked as the handoff point for the next development pass.

Audio and video remain intentionally deferred until the complete investigation flow is in place. Current media views use static previews and archive records only.

The files `trace-arg.html` and `trace-behind-the-filter-combined.html` are preserved as team drafts and visual references. Continue implementation in `behind-the-filter.html`.

## Verification

Run the Chrome smoke test from the repository root:

```powershell
node tests/smoke.mjs
```
