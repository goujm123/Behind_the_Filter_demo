# Behind the Filter

Bilingual browser ARG and Media and Information Literacy investigation game.

## Playable build

Open [`behind-the-filter.html`](./behind-the-filter.html) directly in a browser. The build is an offline bundle with no network dependencies. Keep the `materials/` directory beside the HTML file so local sound, archive, and ending media remain available.

Current milestone: Case 001 scenes P00-P09 are playable from opening through evidence analysis, final recommendation, branch consequence, and case closure.

Media included in the offline bundle: interface sound effects, the `sw1.mp4` reference clip used in P01/P02, the P05 archive recording, and three P08 branch consequence videos. P01 loops the reference clip muted; P02 presents it as a manually controlled attachment.

Background music starts only after the first user interaction and can be muted independently from the interface and video audio. P00-P03 use `glitch故障感bgm.wav`, P04-P08 use `硬核bgm.wav`, and P09 returns to the glitch track at a lower volume. Foreground video audio temporarily fades the music out. P08 consequence videos still attempt playback at 25% volume and fall back to muted playback when required by the browser.

The files `trace-arg.html` and `trace-behind-the-filter-combined.html` are preserved as team drafts and visual references. Continue implementation in `behind-the-filter.html`.

## Verification

Run the Chrome smoke test from the repository root. It covers v1/v2-to-v3 migration, P00-P09 progression, evidence marking and connections, all three decisions, media paths, bilingual rendering, persistence, reset, and responsive screenshots:

```powershell
node tests/smoke.mjs
```
