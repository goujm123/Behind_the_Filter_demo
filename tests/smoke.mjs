import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const browserCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const chromePath = browserCandidates.find(candidate => fs.existsSync(candidate));
assert.ok(chromePath, 'Smoke test requires Chrome or Edge. Set CHROME_PATH to a Chromium browser executable.');
const appPath = path.resolve('behind-the-filter.html');
const appUrl = pathToFileURL(appPath).href;
const port = 9334;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'behind-filter-smoke-'));
const artifacts = path.join(os.tmpdir(), 'behind-filter-smoke-artifacts');
const htmlSource = fs.readFileSync(appPath, 'utf8');
fs.mkdirSync(artifacts, { recursive: true });

assert.equal(htmlSource.includes('AudioContext'), false, 'The build should not depend on Web Audio.');
assert.equal((htmlSource.match(/<video\b/gi) || []).length, 0, 'The playable build must not contain video elements.');
assert.equal(/<[^>]+\scontrols(?:\s|=|>)/i.test(htmlSource), false, 'The playable build must not contain media controls.');
assert.equal(htmlSource.includes('materials/videos/'), false, 'The playable build must not reference legacy video assets.');
const mediaReferences = [...htmlSource.matchAll(/(?:\.\/)?materials\/(?:sound|images\/事件插图)\/[^"'()<>\s]+/gi)].map(match => decodeURIComponent(match[0].replace(/^\.\//, '')));
assert.ok(mediaReferences.length >= 10, 'Expected local sound and event illustration references.');
for (const reference of new Set(mediaReferences)) {
  assert.equal(fs.existsSync(path.resolve(reference)), true, `Missing local media asset: ${reference}`);
}
for (const filename of ['college life.mp4', 'creepshot.mp4', 'ed1.mp4', 'ed2.mp4', 'ed3.mp4', 'original-video.mp4', 'sw1.mp4']) {
  assert.equal(fs.existsSync(path.resolve('materials/videos', filename)), true, `Legacy video file should remain untouched: ${filename}`);
}

const browser = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--disable-extensions',
  '--no-first-run',
  '--no-sandbox',
  '--hide-scrollbars',
  '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  appUrl
], { stdio: 'ignore', windowsHide: true });

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function getTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
      const target = targets.find(item => item.type === 'page' && item.url.includes('behind-the-filter.html'));
      if (target) return target;
    } catch {
      // Chrome has not opened the DevTools endpoint yet.
    }
    await delay(100);
  }
  throw new Error('Chrome DevTools target did not become available.');
}

const target = await getTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let sequence = 0;
const pending = new Map();
const exceptions = [];
const consoleErrors = [];

socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map(argument => argument.value || argument.description).join(' '));
  }
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

async function click(selector) {
  const clicked = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return false; element.click(); return true; })()`);
  assert.equal(clicked, true, `Expected clickable control: ${selector}`);
  await delay(100);
}

async function activatePage() {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 8, y: 8, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 8, y: 8, button: 'left', clickCount: 1 });
  await delay(100);
}

async function activateByKeyboard() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await delay(100);
}

async function snapshot(scene, width, height, { endingArtWindow = false, focusSelector = null, label = null } = {}) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await evaluate(`dispatch('NAVIGATE', { scene: ${JSON.stringify(scene)} })`);
  if (endingArtWindow) await evaluate(`dispatch('OPEN_ENDING_ART')`);
  if (focusSelector) await evaluate(`document.querySelector(${JSON.stringify(focusSelector)})?.scrollIntoView({ block: 'center', behavior: 'auto' })`);
  await evaluate(`liveStatus.classList.remove('is-visible')`);
  await delay(endingArtWindow ? 650 : 180);
  const layout = await evaluate(`({
    scene: state.currentScene,
    viewport: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowingButtons: [...document.querySelectorAll('button')].filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.textContent.trim()),
    overflowingElements: [...document.querySelectorAll('body *')].map(element => ({ element, rect: element.getBoundingClientRect() })).filter(item => item.rect.right > document.documentElement.clientWidth + 1 || item.rect.left < -1).slice(0, 12).map(item => ({ tag: item.element.tagName, className: item.element.className?.toString() || '', left: Math.round(item.rect.left), right: Math.round(item.rect.right), width: Math.round(item.rect.width) }))
  })`);
  assert.equal(layout.scene, scene);
  assert.ok(layout.scrollWidth <= layout.viewport, `${scene} has horizontal overflow at ${width}px: ${JSON.stringify(layout.overflowingElements)}`);
  assert.deepEqual(layout.overflowingButtons, [], `${scene} has overflowing button labels at ${width}px`);
  const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const filename = `${scene}${endingArtWindow ? '-art-window' : label ? `-${label}` : ''}-${width}x${height}.png`;
  fs.writeFileSync(path.join(artifacts, filename), Buffer.from(image.data, 'base64'));
  if (endingArtWindow) await evaluate(`closeEndingArt({ restoreFocus: false, animate: false })`);
  return filename;
}

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await delay(400);

  const initial = await evaluate(`({ scene: state.currentScene, evidence: state.evidence, version: state.version, bgmEnabled: state.bgmEnabled, prompt: document.getElementById('boot-copy').textContent, audioPaused: [typingSound.paused, mailHeartbeatSound.paused, buttonClickSound.paused, backgroundMusic.glitch.paused, backgroundMusic.hardcore.paused], external: [...document.querySelectorAll('[src],[href]')].map(element => element.src || element.href).filter(value => /^https?:/.test(value)) })`);
  assert.equal(initial.scene, 'P00');
  assert.equal(initial.version, 3);
  assert.deepEqual(initial.evidence, []);
  assert.equal(initial.prompt.includes('CLICK ANYWHERE TO INITIALIZE'), true);
  assert.equal(initial.bgmEnabled, true);
  assert.deepEqual(initial.audioPaused, [true, true, true, true, true]);
  assert.deepEqual(initial.external, []);

  await evaluate(`localStorage.setItem('behind-the-filter.case001.v1', JSON.stringify({ version: 1, language: 'zh', currentScene: 'P03', maxUnlockedScene: 'P04', evidence: ['A', 'E'], replyChoice: 1, replySent: true, openingSeen: true }))`);
  await send('Page.reload', { ignoreCache: true });
  await delay(500);
  const migratedV1 = await evaluate(`({ version: state.version, language: state.language, scene: state.currentScene, maxScene: state.maxUnlockedScene, evidence: state.evidence, replySent: state.replySent, bgmEnabled: state.bgmEnabled, v3Stored: Boolean(localStorage.getItem('behind-the-filter.case001.v3')) })`);
  assert.equal(migratedV1.version, 3);
  assert.equal(migratedV1.language, 'zh');
  assert.equal(migratedV1.scene, 'P03');
  assert.equal(migratedV1.maxScene, 'P04');
  assert.deepEqual(migratedV1.evidence, ['A', 'E']);
  assert.equal(migratedV1.replySent, true);
  assert.equal(migratedV1.bgmEnabled, true);
  assert.equal(migratedV1.v3Stored, true);
  await evaluate(`dispatch('CONFIRM_RESET')`);

  await evaluate(`localStorage.setItem('behind-the-filter.case001.v2', JSON.stringify({ version: 2, language: 'en', currentScene: 'P06', maxUnlockedScene: 'P07', evidence: ['A', 'B', 'C', 'D', 'E'], selectedSearchQuery: 'festival', visitedQueries: ['maya', 'festival'], archiveRecordInspected: true, uploaderAnalysisOpened: true, openingSeen: true }))`);
  await send('Page.reload', { ignoreCache: true });
  await delay(500);
  const migratedV2 = await evaluate(`({ version: state.version, scene: state.currentScene, maxScene: state.maxUnlockedScene, evidence: state.evidence, inspected: state.archiveRecordInspected, analyzed: state.uploaderAnalysisOpened, bgmEnabled: state.bgmEnabled, v3Stored: Boolean(localStorage.getItem('behind-the-filter.case001.v3')) })`);
  assert.equal(migratedV2.version, 3);
  assert.equal(migratedV2.scene, 'P06');
  assert.equal(migratedV2.maxScene, 'P07');
  assert.deepEqual(migratedV2.evidence, ['A', 'B', 'C', 'D', 'E']);
  assert.equal(migratedV2.inspected, true);
  assert.equal(migratedV2.analyzed, true);
  assert.equal(migratedV2.bgmEnabled, true);
  assert.equal(migratedV2.v3Stored, true);
  await evaluate(`dispatch('CONFIRM_RESET')`);

  assert.equal(await evaluate(`document.getElementById('boot-copy').textContent.includes('CLICK ANYWHERE TO INITIALIZE')`), true);
  await evaluate(`(() => {
    window.__originalBgmPlay = HTMLMediaElement.prototype.play;
    window.__rejectBgmPlay = true;
    window.__bgmPlayAttempts = 0;
    HTMLMediaElement.prototype.play = function() {
      if (Object.values(backgroundMusic).includes(this)) {
        window.__bgmPlayAttempts += 1;
        if (window.__rejectBgmPlay) return Promise.reject(new DOMException('BGM blocked', 'NotAllowedError'));
      }
      return window.__originalBgmPlay.call(this);
    };
  })()`);
  await activateByKeyboard();
  await delay(180);
  const rejectedBgm = await evaluate(`({ attempts: window.__bgmPlayAttempts, paused: backgroundMusic.glitch.paused, unlocked: bgmUnlocked })`);
  assert.ok(rejectedBgm.attempts >= 1);
  assert.equal(rejectedBgm.paused, true);
  assert.equal(rejectedBgm.unlocked, true);
  await evaluate(`window.__rejectBgmPlay = false`);
  await activatePage();
  await delay(5600);
  assert.equal(await evaluate(`!document.getElementById('boot-action').hidden`), true, 'P00 enter control should appear after activation and typing.');
  const openingBgm = await evaluate(`({ key: activeBgmKey, paused: backgroundMusic.glitch.paused, volume: backgroundMusic.glitch.volume, hardcorePaused: backgroundMusic.hardcore.paused })`);
  assert.equal(openingBgm.key, 'glitch');
  assert.equal(openingBgm.paused, false);
  assert.ok(Math.abs(openingBgm.volume - 0.07) < 0.002);
  assert.equal(openingBgm.hardcorePaused, true);

  await click('[data-action="TOGGLE_BGM"]');
  await delay(500);
  const bgmDisabled = await evaluate(`({ enabled: state.bgmEnabled, stored: JSON.parse(localStorage.getItem('behind-the-filter.case001.v3')).bgmEnabled, paused: Object.values(backgroundMusic).every(audio => audio.paused), buttonPressed: document.querySelector('[data-action="TOGGLE_BGM"]').getAttribute('aria-pressed') })`);
  assert.equal(bgmDisabled.enabled, false);
  assert.equal(bgmDisabled.stored, false);
  assert.equal(bgmDisabled.paused, true);
  assert.equal(bgmDisabled.buttonPressed, 'false');
  await click('[data-action="TOGGLE_BGM"]');
  await delay(700);
  assert.equal(await evaluate(`state.bgmEnabled && !backgroundMusic.glitch.paused`), true);

  await click('[data-action="ENTER_SYSTEM"]');
  const p01Art = await evaluate(`(() => { const image = document.querySelector('.case-preview-art'); const motion = image.closest('.art-motion'); return { src: decodeURI(image.src), alt: image.alt, expectedAlt: COPY.en.p01.artAlt, variant: motion.className, motionAnimation: getComputedStyle(motion).animationName, scanAnimation: getComputedStyle(motion, '::before').animationName, sweepAnimation: getComputedStyle(motion, '::after').animationName, videoCount: document.querySelectorAll('video').length, controlsCount: document.querySelectorAll('[controls]').length, progressPresent: Boolean(document.querySelector('.player-progress')) }; })()`);
  assert.equal(p01Art.src.endsWith('/事件插图/开头.PNG'), true);
  assert.equal(p01Art.alt, p01Art.expectedAlt);
  assert.equal(p01Art.variant.includes('art-motion--signal'), true);
  assert.equal(p01Art.motionAnimation, 'art-signal-breathe');
  assert.equal(p01Art.scanAnimation, 'art-scan-drift');
  assert.equal(p01Art.sweepAnimation, 'art-signal-sweep');
  assert.equal(p01Art.videoCount, 0);
  assert.equal(p01Art.controlsCount, 0);
  assert.equal(p01Art.progressPresent, false);
  await click('[data-action="START_CASE"]');
  assert.equal(await evaluate('state.currentScene'), 'P02');
  const p02Art = await evaluate(`(() => { const image = document.querySelector('.attachment-art'); const motion = image.closest('.art-motion'); return { src: decodeURI(image.src), alt: image.alt, expectedAlt: COPY.en.p02.artAlt, variant: motion.className, imageAnimation: getComputedStyle(image).animationName, scanAnimation: getComputedStyle(motion, '::before').animationName, sweepAnimation: getComputedStyle(motion, '::after').animationName, videoCount: document.querySelectorAll('video').length, bgmPaused: backgroundMusic.glitch.paused, bgmVolume: backgroundMusic.glitch.volume }; })()`);
  assert.equal(p02Art.src.endsWith('/事件插图/被换脸.PNG'), true);
  assert.equal(p02Art.alt, p02Art.expectedAlt);
  assert.equal(p02Art.variant.includes('art-motion--glitch'), true);
  assert.equal(p02Art.imageAnimation, 'art-pixel-jitter');
  assert.equal(p02Art.scanAnimation, 'art-scan-drift');
  assert.equal(p02Art.sweepAnimation, 'art-signal-sweep');
  assert.equal(p02Art.videoCount, 0);
  assert.equal(p02Art.bgmPaused, false);
  assert.ok(Math.abs(p02Art.bgmVolume - 0.07) < 0.002);
  await evaluate(`HTMLMediaElement.prototype.play = window.__originalBgmPlay`);

  await click('[data-action="OPEN_REPLY"]');
  await click('input[name="reply-choice"][value="1"]');
  await evaluate(`document.querySelector('[data-reply-form]').requestSubmit()`);
  await delay(100);
  assert.equal(await evaluate('state.replySent'), true);
  assert.equal(await evaluate(`document.activeElement.id`), 'dialog-close');
  assert.equal(await evaluate('app.inert'), true);
  await click('[data-action="CLOSE_MODAL"]');
  assert.equal(await evaluate('app.inert'), false);
  await click('[data-action="SAVE_EVIDENCE"][data-evidence="E"]');
  await click('[data-action="CLOSE_MODAL"]');
  await click('[data-action="OPEN_POST"]');
  const p03Art = await evaluate(`(() => { const motion = document.querySelector('.viral-still'); const image = motion.querySelector('.viral-still-image'); return { src: decodeURI(image.src), variant: motion.className, imageAnimation: getComputedStyle(image).animationName, badgeZ: getComputedStyle(motion.querySelector('.media-static-badge')).zIndex }; })()`);
  assert.equal(p03Art.src.endsWith('/事件插图/被换脸.PNG'), true);
  assert.equal(p03Art.variant.includes('art-motion--glitch'), true);
  assert.equal(p03Art.imageAnimation, 'art-pixel-jitter');
  assert.ok(Number(p03Art.badgeZ) > 2);
  await click('[data-action="SAVE_EVIDENCE"][data-evidence="A"]');
  await click('[data-action="CLOSE_MODAL"]');
  await click('[data-action="UNLOCK_SEARCH"]');
  await delay(700);
  const investigationBgm = await evaluate(`({ key: activeBgmKey, glitchPaused: backgroundMusic.glitch.paused, hardcorePaused: backgroundMusic.hardcore.paused, volume: backgroundMusic.hardcore.volume })`);
  assert.equal(investigationBgm.key, 'hardcore');
  assert.equal(investigationBgm.glitchPaused, true);
  assert.equal(investigationBgm.hardcorePaused, false);
  assert.ok(Math.abs(investigationBgm.volume - 0.055) < 0.002);

  for (const query of ['uploader', 'headline', 'police']) {
    await click(`[data-action="SELECT_SEARCH_QUERY"][data-query="${query}"]`);
    await click(`[data-action="OPEN_SEARCH_RESULT"][data-query="${query}"]`);
    await click('[data-action="CLOSE_MODAL"]');
  }
  await click('[data-action="SELECT_SEARCH_QUERY"][data-query="festival"]');
  await click('[data-action="OPEN_SEARCH_RESULT"][data-query="festival"]');
  assert.equal(await evaluate(`decodeURI(document.querySelector('.archive-event-art img').src).endsWith('/事件插图/毕业.PNG')`), true);
  const campusMotion = await evaluate(`(() => { const motion = document.querySelector('.archive-event-art .art-motion'); const image = motion.querySelector('.art-motion-image'); return { variant: motion.className, motionAnimation: getComputedStyle(motion).animationName, imageAnimation: getComputedStyle(image).animationName, scanAnimation: getComputedStyle(motion, '::before').animationName, sweepAnimation: getComputedStyle(motion, '::after').animationName }; })()`);
  assert.equal(campusMotion.variant.includes('art-motion--archive'), true);
  assert.equal(campusMotion.motionAnimation, 'none');
  assert.equal(campusMotion.imageAnimation, 'none');
  assert.equal(campusMotion.scanAnimation, 'art-scan-drift');
  assert.equal(campusMotion.sweepAnimation, 'none');
  await click('[data-action="INSPECT_ARCHIVE"]');
  const archiveArt = await evaluate(`(() => { const image = document.querySelector('.archive-frame-art'); const motion = image.closest('.art-motion'); return { src: decodeURI(image.src), alt: image.alt, expectedAlt: COPY.en.p05.frameArtAlt, variant: motion.className, imageAnimation: getComputedStyle(image).animationName, sweepAnimation: getComputedStyle(motion, '::after').animationName, videoCount: document.querySelectorAll('video').length }; })()`);
  assert.equal(archiveArt.src.endsWith('/事件插图/直播.PNG'), true);
  assert.equal(archiveArt.alt, archiveArt.expectedAlt);
  assert.equal(archiveArt.variant.includes('art-motion--archive'), true);
  assert.equal(archiveArt.imageAnimation, 'none');
  assert.equal(archiveArt.sweepAnimation, 'none');
  assert.equal(archiveArt.videoCount, 0);
  await click('[data-action="SAVE_EVIDENCE"][data-evidence="B"]');
  await click('[data-action="CLOSE_MODAL"]');
  await click('[data-action="OPEN_SOURCE_TRACE"]');
  await click('[data-action="SAVE_EVIDENCE"][data-evidence="D"]');
  await click('[data-action="CLOSE_MODAL"]');
  await click('[data-action="OPEN_UPLOADER_ANALYSIS"]');
  await click('[data-action="SAVE_EVIDENCE"][data-evidence="C"]');
  await click('[data-action="CLOSE_MODAL"]');
  assert.deepEqual(await evaluate('state.evidence'), ['E', 'A', 'B', 'D', 'C']);

  await click('[data-action="UNLOCK_BOARD"]');
  assert.equal(await evaluate('state.currentScene'), 'P07');
  assert.equal(await evaluate('state.maxUnlockedScene'), 'P07');
  assert.equal(await evaluate(`document.querySelectorAll('[data-evidence-card]').length`), 6);

  await click('[data-action="MARK_EVIDENCE"][data-evidence="A"][data-mark="VERIFIED"]');
  assert.equal(await evaluate(`Object.hasOwn(state.evidenceMarks, 'A')`), false);
  await click('[data-action="CLOSE_MODAL"]');
  for (const [id, mark] of [['A', 'UNVERIFIED'], ['B', 'VERIFIED'], ['C', 'UNVERIFIED'], ['D', 'VERIFIED'], ['E', 'VERIFIED']]) {
    await click(`[data-action="MARK_EVIDENCE"][data-evidence="${id}"][data-mark="${mark}"]`);
  }

  await click('[data-action="CONNECT_EVIDENCE"][data-evidence="A"]');
  await click('[data-action="CONNECT_EVIDENCE"][data-evidence="C"]');
  assert.equal(await evaluate('state.evidenceConnections.length'), 0);
  assert.equal(await evaluate(`document.getElementById('dialog-title').textContent`), 'NO DIRECT RELATIONSHIP');
  await click('[data-action="CLOSE_MODAL"]');

  await click('[data-action="INSPECT_FRAME_ANALYSIS"]');
  assert.equal(await evaluate('state.frameAnalysisInspected'), true);
  assert.equal(await evaluate(`Boolean(document.getElementById('analysis-record'))`), true);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.analysis-frame-image')].map(image => decodeURI(image.src).split('/').pop())`), ['直播.PNG', '被换脸.PNG']);
  const analysisMotion = await evaluate(`[...document.querySelectorAll('.analysis-frame')].map(motion => ({ variant: motion.className, imageAnimation: getComputedStyle(motion.querySelector('.analysis-frame-image')).animationName, scanAnimation: getComputedStyle(motion, '::before').animationName, labelZ: getComputedStyle(motion.querySelector('span')).zIndex }))`);
  assert.equal(analysisMotion[0].variant.includes('art-motion--archive'), true);
  assert.equal(analysisMotion[0].imageAnimation, 'none');
  assert.equal(analysisMotion[1].variant.includes('art-motion--glitch'), true);
  assert.equal(analysisMotion[1].imageAnimation, 'art-pixel-jitter');
  assert.equal(analysisMotion.every(item => item.scanAnimation === 'art-scan-drift' && Number(item.labelZ) > 2), true);
  await click('[data-action="SAVE_EVIDENCE"][data-evidence="F"]');
  await click('[data-action="CLOSE_MODAL"]');
  await click('[data-action="MARK_EVIDENCE"][data-evidence="F"][data-mark="ALTERED"]');

  for (const [first, second] of [['A', 'B'], ['C', 'D']]) {
    await click(`[data-action="CONNECT_EVIDENCE"][data-evidence="${first}"]`);
    await click(`[data-action="CONNECT_EVIDENCE"][data-evidence="${second}"]`);
  }
  const analysisComplete = await evaluate(`({ analysis: getAnalysisStatus(), evidence: state.evidence, marks: state.evidenceMarks, connections: state.evidenceConnections, lines: document.querySelectorAll('#connection-overlay line').length })`);
  assert.equal(analysisComplete.analysis.level, 'complete');
  assert.equal(analysisComplete.analysis.correctCount, 6);
  assert.deepEqual(analysisComplete.connections, ['A-B', 'C-D']);
  assert.equal(analysisComplete.lines, 2);

  await click('[data-action="OPEN_DECISION"]');
  assert.equal(await evaluate('state.currentScene'), 'P08');
  assert.equal(await evaluate(`document.querySelector('[data-decision="FLAG_MANIPULATED"]').disabled`), false);
  await delay(400);
  assert.equal(await evaluate(`activeBgmKey === 'hardcore' && !backgroundMusic.hardcore.paused && Math.abs(backgroundMusic.hardcore.volume - 0.045) < 0.002`), true);

  const branchCases = [
    ['PUBLISH', '结局一.PNG'],
    ['VERIFY_FURTHER', '结局二.PNG'],
    ['FLAG_MANIPULATED', '结局三.PNG']
  ];
  for (const [decision, illustration] of branchCases) {
    await click(`[data-action="SELECT_DECISION"][data-decision="${decision}"]`);
    await click('[data-action="SUBMIT_DECISION"]');
    await delay(120);
    const outcomeArt = await evaluate(`(() => {
      const image = document.querySelector('[data-ending-art]');
      const motion = image.closest('.art-motion');
      return {
        finalDecision: state.finalDecision,
        src: decodeURI(image.src),
        alt: image.alt,
        expectedChoiceTitle: COPY.en.p08.choices.find(choice => choice.id === ${JSON.stringify(decision)}).title,
        decision: image.dataset.decision,
        open: endingArtOpen && !endingArtLayer.hidden,
        focus: document.activeElement.id,
        videoCount: document.querySelectorAll('video').length,
        controlsCount: document.querySelectorAll('[controls]').length,
        inPageArt: Boolean(document.querySelector('#decision-feedback [data-ending-art]')),
        feedbackGrid: Boolean(document.querySelector('#decision-feedback .feedback-layout')),
        variant: motion.className,
        motionAnimation: getComputedStyle(motion).animationName,
        imageAnimation: getComputedStyle(image).animationName,
        scanAnimation: getComputedStyle(motion, '::before').animationName,
        sweepAnimation: getComputedStyle(motion, '::after').animationName
      };
    })()`);
    assert.equal(outcomeArt.finalDecision, decision);
    assert.equal(outcomeArt.src.endsWith(`/事件插图/${illustration}`), true);
    assert.equal(outcomeArt.alt.includes(outcomeArt.expectedChoiceTitle), true);
    assert.equal(outcomeArt.decision, decision);
    assert.equal(outcomeArt.open, true);
    assert.equal(outcomeArt.focus, 'ending-art-close');
    assert.equal(outcomeArt.videoCount, 0);
    assert.equal(outcomeArt.controlsCount, 0);
    assert.equal(outcomeArt.inPageArt, false);
    assert.equal(outcomeArt.feedbackGrid, false);
    assert.equal(outcomeArt.variant.includes('art-motion--outcome'), true);
    assert.equal(outcomeArt.motionAnimation, 'art-outcome-reveal');
    assert.equal(outcomeArt.imageAnimation, 'none');
    assert.equal(outcomeArt.scanAnimation, 'art-scan-drift');
    assert.equal(outcomeArt.sweepAnimation, 'art-signal-sweep');
    if (decision !== 'FLAG_MANIPULATED') await click('[data-action="RESELECT_DECISION"]');
  }

  await evaluate(`window.__endingArtNode = document.querySelector('[data-ending-art]'); dispatch('TOGGLE_LANGUAGE')`);
  const translatedWindow = await evaluate(`({ sameArt: window.__endingArtNode === document.querySelector('[data-ending-art]'), title: document.getElementById('ending-art-title').textContent, expectedTitle: COPY.zh.p08.endingArtTitle, alt: document.querySelector('[data-ending-art]').alt, expectedAltPrefix: COPY.zh.p08.endingArtAlt })`);
  assert.equal(translatedWindow.sameArt, true);
  assert.equal(translatedWindow.title, translatedWindow.expectedTitle);
  assert.equal(translatedWindow.alt.includes(translatedWindow.expectedAltPrefix), true);
  await evaluate(`dispatch('TOGGLE_LANGUAGE')`);

  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await delay(220);
  assert.equal(await evaluate(`endingArtLayer.hidden && !endingArtOpen`), true);
  assert.equal(await evaluate(`document.activeElement.dataset.action`), 'OPEN_ENDING_ART');

  await click('[data-action="OPEN_ENDING_ART"]');
  const reopenedArt = await evaluate(`({ open: endingArtOpen, src: decodeURI(document.querySelector('[data-ending-art]').src), freshNode: window.__endingArtNode !== document.querySelector('[data-ending-art]'), revealAnimation: getComputedStyle(document.querySelector('.ending-art-stage')).animationName })`);
  assert.equal(reopenedArt.open, true);
  assert.equal(reopenedArt.src.endsWith('/事件插图/结局三.PNG'), true);
  assert.equal(reopenedArt.freshNode, true);
  assert.equal(reopenedArt.revealAnimation, 'art-outcome-reveal');
  await send('Page.reload', { ignoreCache: true });
  await delay(500);
  const restoredDecision = await evaluate(`({ scene: state.currentScene, finalDecision: state.finalDecision, windowOpen: endingArtOpen, layerHidden: endingArtLayer.hidden, hasArt: Boolean(document.querySelector('[data-ending-art]')), hasReopen: Boolean(document.querySelector('[data-action="OPEN_ENDING_ART"]')), videoCount: document.querySelectorAll('video').length })`);
  assert.equal(restoredDecision.scene, 'P08');
  assert.equal(restoredDecision.finalDecision, 'FLAG_MANIPULATED');
  assert.equal(restoredDecision.windowOpen, false);
  assert.equal(restoredDecision.layerHidden, true);
  assert.equal(restoredDecision.hasArt, false);
  assert.equal(restoredDecision.hasReopen, true);
  assert.equal(restoredDecision.videoCount, 0);

  await activatePage();
  await click('[data-action="CLOSE_CASE"]');
  assert.equal(await evaluate('state.currentScene'), 'P09');
  assert.equal(await evaluate('state.caseClosed'), true);
  await delay(700);
  assert.equal(await evaluate(`activeBgmKey === 'glitch' && !backgroundMusic.glitch.paused && Math.abs(backgroundMusic.glitch.volume - 0.035) < 0.002 && backgroundMusic.hardcore.paused`), true);
  await evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'))`);
  assert.equal(await evaluate(`Object.values(backgroundMusic).every(audio => audio.paused && audio.volume === 0)`), true);
  await evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'))`);
  await delay(700);
  assert.equal(await evaluate(`!backgroundMusic.glitch.paused && Math.abs(backgroundMusic.glitch.volume - 0.035) < 0.002`), true);
  await evaluate(`delete document.hidden`);
  assert.equal(await evaluate(`document.querySelector('.ending-copy').textContent.includes("Maya Lin's face was real")`), true);
  await click('[data-action="REVEAL_ENDING"]');
  assert.equal(await evaluate('state.endingRevealed'), true);
  assert.equal(await evaluate(`document.activeElement.id`), 'ending-final');
  await click('[data-action="RETURN_TRACE"]');
  assert.equal(await evaluate('state.currentScene'), 'P01');
  assert.equal(await evaluate(`document.querySelector('[data-action="REVIEW_CASE"]').textContent.includes(COPY.en.p01.review)`), true);

  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await evaluate(`dispatch('NAVIGATE', { scene: 'P08' }); dispatch('OPEN_ENDING_ART')`);
  const reducedWindow = await evaluate(`(() => { const windowElement = document.querySelector('.ending-art-window'); const motion = document.querySelector('.ending-art-stage'); const image = motion.querySelector('.ending-art-image'); const result = { animationDuration: parseFloat(getComputedStyle(windowElement).animationDuration), motionAnimation: getComputedStyle(motion).animationName, motionClip: getComputedStyle(motion).clipPath, imageAnimation: getComputedStyle(image).animationName, imageTransform: getComputedStyle(image).transform, scanAnimation: getComputedStyle(motion, '::before').animationName, sweepAnimation: getComputedStyle(motion, '::after').animationName, sweepOpacity: getComputedStyle(motion, '::after').opacity }; closeEndingArt(); return { ...result, hiddenImmediately: endingArtLayer.hidden }; })()`);
  assert.ok(reducedWindow.animationDuration <= 0.001, 'Reduced motion should suppress the outcome art window animation.');
  assert.equal(reducedWindow.hiddenImmediately, true, 'Reduced motion should close the outcome art window immediately.');
  assert.equal(reducedWindow.motionAnimation, 'none');
  assert.equal(reducedWindow.motionClip, 'none');
  assert.equal(reducedWindow.imageAnimation, 'none');
  assert.equal(reducedWindow.imageTransform, 'none');
  assert.equal(reducedWindow.scanAnimation, 'none');
  assert.equal(reducedWindow.sweepAnimation, 'none');
  assert.equal(reducedWindow.sweepOpacity, '0');
  await evaluate(`dispatch('NAVIGATE', { scene: 'P02' })`);
  const reducedGlitch = await evaluate(`(() => { const motion = document.querySelector('.art-motion--glitch'); const image = motion.querySelector('.art-motion-image'); return { motionAnimation: getComputedStyle(motion).animationName, imageAnimation: getComputedStyle(image).animationName, imageTransform: getComputedStyle(image).transform, sweepAnimation: getComputedStyle(motion, '::after').animationName, sweepOpacity: getComputedStyle(motion, '::after').opacity }; })()`);
  assert.equal(reducedGlitch.motionAnimation, 'none');
  assert.equal(reducedGlitch.imageAnimation, 'none');
  assert.equal(reducedGlitch.imageTransform, 'none');
  assert.equal(reducedGlitch.sweepAnimation, 'none');
  assert.equal(reducedGlitch.sweepOpacity, '0');
  await evaluate(`state.openingSeen = false; dispatch('NAVIGATE', { scene: 'P00' })`);
  assert.equal(await evaluate(`!document.getElementById('boot-action').hidden`), true, 'Reduced motion should reveal P00 immediately.');
  await send('Emulation.setEmulatedMedia', { features: [] });
  await evaluate(`state.openingSeen = true; state.endingRevealed = true; saveState()`);

  await evaluate(`dispatch('TOGGLE_LANGUAGE')`);
  assert.equal(await evaluate('state.language'), 'zh');
  for (const scene of ['P00', 'P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09']) {
    await evaluate(`dispatch('NAVIGATE', { scene: ${JSON.stringify(scene)} })`);
    const translated = await evaluate(`(() => {
      const key = ${JSON.stringify(scene.toLowerCase())};
      if (key === 'p00') return document.getElementById('boot-copy').textContent.includes(COPY.zh.p00.text.slice(0, 8));
      if (key === 'p09') return document.querySelector('.ending-copy').textContent.includes(COPY.zh.p09.final.slice(0, 8));
      const expected = key === 'p05' ? COPY.zh.p05.university : COPY.zh[key].title;
      return document.getElementById('scene-title').textContent.replace(/\\s+/g, '').includes(expected.replace(/\\s+/g, ''));
    })()`);
    assert.equal(translated, true, `${scene} should render Chinese copy.`);
  }
  await evaluate(`dispatch('TOGGLE_LANGUAGE')`);

  const screenshots = [];
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
    for (const scene of ['P00', 'P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09']) screenshots.push(await snapshot(scene, width, height));
    screenshots.push(await snapshot('P02', width, height, { focusSelector: '.attachment', label: 'attachment' }));
    screenshots.push(await snapshot('P05', width, height, { focusSelector: '.archive-frame-art', label: 'archive-art' }));
    screenshots.push(await snapshot('P07', width, height, { focusSelector: '#analysis-record', label: 'analysis' }));
    screenshots.push(await snapshot('P08', width, height, { endingArtWindow: true }));
  }

  const incompleteState = {
    version: 3, language: 'en', currentScene: 'P07', maxUnlockedScene: 'P07', evidence: ['E', 'F'], replyChoice: null, replySent: false, openingSeen: true,
    selectedSearchQuery: 'maya', visitedQueries: [], archiveRecordInspected: false, uploaderAnalysisOpened: false,
    evidenceMarks: { E: 'VERIFIED', F: 'ALTERED' }, evidenceConnections: [], frameAnalysisInspected: true, finalDecision: null, caseClosed: false, endingRevealed: false
  };
  await evaluate(`localStorage.setItem('behind-the-filter.case001.v3', ${JSON.stringify(JSON.stringify(incompleteState))})`);
  await send('Page.reload', { ignoreCache: true });
  await delay(400);
  await click('[data-action="OPEN_DECISION"]');
  assert.equal(await evaluate(`document.getElementById('dialog-title').textContent`), 'CONTINUE WITH INCOMPLETE ANALYSIS?');
  await click('[data-action="CONFIRM_INCOMPLETE_DECISION"]');
  const incompleteDecision = await evaluate(`({ scene: state.currentScene, level: getAnalysisStatus().level, flagDisabled: document.querySelector('[data-decision="FLAG_MANIPULATED"]').disabled, publishDisabled: document.querySelector('[data-decision="PUBLISH"]').disabled, verifyDisabled: document.querySelector('[data-decision="VERIFY_FURTHER"]').disabled })`);
  assert.equal(incompleteDecision.scene, 'P08');
  assert.equal(incompleteDecision.level, 'insufficient');
  assert.equal(incompleteDecision.flagDisabled, true);
  assert.equal(incompleteDecision.publishDisabled, false);
  assert.equal(incompleteDecision.verifyDisabled, false);

  await evaluate(`dispatch('OPEN_RESET')`);
  await click('[data-action="CONFIRM_RESET"]');
  const reset = await evaluate(`({ scene: state.currentScene, evidence: state.evidence, language: state.language, bgmEnabled: state.bgmEnabled, v1: localStorage.getItem('behind-the-filter.case001.v1'), v2: localStorage.getItem('behind-the-filter.case001.v2'), v3: localStorage.getItem('behind-the-filter.case001.v3') })`);
  assert.equal(reset.scene, 'P00');
  assert.deepEqual(reset.evidence, []);
  assert.equal(reset.language, 'en');
  assert.equal(reset.bgmEnabled, true);
  assert.equal(reset.v1, null);
  assert.equal(reset.v2, null);
  assert.equal(reset.v3, null);

  assert.deepEqual(exceptions, [], `Runtime exceptions: ${exceptions.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join('\n')}`);

  console.log(JSON.stringify({
    passed: true,
    flow: 'P00 -> P01 -> P02 -> P03 -> P04 -> P05 -> P06 -> P07 -> P08 -> P09 -> P01',
    migration: 'v1 and v2 state preserved as v3',
    evidenceBoard: 'six marks, valid/invalid connections, F analysis, and incomplete path verified',
    decisions: 'three static consequence illustrations and illustration-only outcome window verified',
    motion: 'CSS illustration variants and reduced-motion fallback verified',
    screenshots: screenshots.map(filename => path.join(artifacts, filename))
  }, null, 2));
} finally {
  socket.close();
  if (browser.exitCode === null) {
    browser.kill();
    await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(1500)]);
  }
  if (profile.startsWith(os.tmpdir())) {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    } catch {
      // Chrome can retain transient profile locks; they remain confined to the OS temp directory.
    }
  }
}
