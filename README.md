# Behind the Filter

Bilingual browser ARG and Media and Information Literacy investigation game.

## Playable build

Open [`behind-the-filter.html`](./behind-the-filter.html) directly in a browser. The build is an offline bundle with no network dependencies. Keep the `materials/` directory beside the HTML file so local sound and event illustrations remain available.

Current milestone: Case 001 scenes P00-P09 are playable from opening through evidence analysis, final recommendation, branch consequence, and case closure.

The playable build uses interface sound effects and the event illustrations in `materials/images/事件插图/`. P01, P02, P03, P05, P07, and all three P08 outcomes are presented as static illustrations with no video elements or playback controls. The legacy files in `materials/videos/` remain in the repository for archival purposes but are not referenced by the playable HTML.

Background music starts only after the first user interaction and can be muted independently from the interface sounds. P00-P03 use `glitch故障感bgm.wav`, P04-P08 use `硬核bgm.wav`, and P09 returns to the glitch track at a lower volume.

The files `trace-arg.html` and `trace-behind-the-filter-combined.html` are preserved as team drafts and visual references. Continue implementation in `behind-the-filter.html`.

## Verification

Run the Chromium smoke test from the repository root. It automatically finds Chrome or Edge (or uses `CHROME_PATH`) and covers v1/v2-to-v3 migration, P00-P09 progression, evidence marking and connections, static illustration mappings, the absence of runtime video references and controls, all three decisions, bilingual rendering, persistence, reset, and responsive screenshots:

```powershell
node tests/smoke.mjs
```
