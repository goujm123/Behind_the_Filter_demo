import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const appPath = path.resolve('behind-the-filter.html');
const appUrl = pathToFileURL(appPath).href;
const port = 9334;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'behind-filter-smoke-'));
const artifacts = path.join(os.tmpdir(), 'behind-filter-smoke-artifacts');
const htmlSource = fs.readFileSync(appPath, 'utf8');
fs.mkdirSync(artifacts, { recursive: true });

assert.equal(htmlSource.includes('AudioContext'), false, 'The build should not depend on Web Audio.');
assert.ok((htmlSource.match(/<video\b/gi) || []).length >= 2, 'Archive and ending video players should be present.');
const mediaReferences = [...htmlSource.matchAll(/(?:\.\/)?materials\/(?:sound|videos)\/[^"'()<>\s]+/gi)].map(match => decodeURIComponent(match[0].replace(/^\.\//, '')));
assert.ok(mediaReferences.length >= 10, 'Expected local sound, BGM, opening, archive, and ending media references.');
for (const reference of new Set(mediaReferences)) {
  assert.equal(fs.existsSync(path.resolve(reference)), true, `Missing local media asset: ${reference}`);
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

async function snapshot(scene, width, height, { endingWindow = false, focusSelector = null, label = null } = {}) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await evaluate(`dispatch('NAVIGATE', { scene: ${JSON.stringify(scene)} })`);
  if (endingWindow) await evaluate(`dispatch('OPEN_ENDING_VIDEO')`);
  if (focusSelector) await evaluate(`document.querySelector(${JSON.stringify(focusSelector)})?.scrollIntoView({ block: 'center', behavior: 'auto' })`);
  await evaluate(`liveStatus.classList.remove('is-visible')`);
  await delay(endingWindow ? 280 : 180);
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
  const filename = `${scene}${endingWindow ? '-video-window' : label ? `-${label}` : ''}-${width}x${height}.png`;
  fs.writeFileSync(path.join(artifacts, filename), Buffer.from(image.data, 'base64'));
  if (endingWindow) await evaluate(`closeEndingVideo({ restoreFocus: false, animate: false })`);
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
  const p01Video = await evaluate(`(() => { const video = document.querySelector('.case-preview-video'); return { src: video.querySelector('source').getAttribute('src'), autoplay: video.autoplay, muted: video.muted, loop: video.loop, controls: video.controls, playsInline: video.playsInline }; })()`);
  assert.equal(p01Video.src, 'materials/videos/sw1.mp4');
  assert.equal(p01Video.autoplay, true);
  assert.equal(p01Video.muted, true);
  assert.equal(p01Video.loop, true);
  assert.equal(p01Video.controls, true);
  assert.equal(p01Video.playsInline, true);
  await click('[data-action="START_CASE"]');
  assert.equal(await evaluate('state.currentScene'), 'P02');
  const p02Video = await evaluate(`(() => { const video = document.querySelector('.attachment-video'); return { src: video.querySelector('source').getAttribute('src'), autoplay: video.autoplay, loop: video.loop, controls: video.controls, playsInline: video.playsInline, paused: video.paused }; })()`);
  assert.equal(p02Video.src, 'materials/videos/sw1.mp4');
  assert.equal(p02Video.autoplay, false);
  assert.equal(p02Video.loop, false);
  assert.equal(p02Video.controls, true);
  assert.equal(p02Video.playsInline, true);
  assert.equal(p02Video.paused, true);
  await evaluate(`document.querySelector('.attachment-video').play()`);
  await delay(550);
  const foregroundSuppression = await evaluate(`({ foreground: activeForegroundMedia.size, bgmPaused: backgroundMusic.glitch.paused, bgmVolume: backgroundMusic.glitch.volume, heartbeatPaused: mailHeartbeatSound.paused })`);
  assert.equal(foregroundSuppression.foreground, 1);
  assert.equal(foregroundSuppression.bgmPaused, true);
  assert.equal(foregroundSuppression.bgmVolume, 0);
  assert.equal(foregroundSuppression.heartbeatPaused, true);
  await evaluate(`document.querySelector('.attachment-video').pause()`);
  await delay(450);
  assert.equal(await evaluate(`activeForegroundMedia.size === 0 && !backgroundMusic.glitch.paused && Math.abs(backgroundMusic.glitch.volume - 0.07) < 0.002`), true);
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
  await click('[data-action="INSPECT_ARCHIVE"]');
  assert.equal(await evaluate(`document.querySelector('.archive-frame-video source').getAttribute('src')`), 'materials/videos/original-video.mp4');
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

  await evaluate(`(() => {
    window.__endingPlayMode = 'resolve';
    window.__endingPlayCalls = [];
    window.__originalMediaPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() {
      if (!this.matches?.('[data-ending-video]')) return window.__originalMediaPlay.call(this);
      window.__endingPlayCalls.push({ muted: this.muted, volume: this.volume });
      if (window.__endingPlayMode === 'reject-all' || (window.__endingPlayMode === 'reject-audible' && !this.muted)) {
        return Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'));
      }
      return Promise.resolve();
    };
  })()`);

  const branchCases = [
    ['PUBLISH', 'ed1.mp4', 'reject-audible'],
    ['VERIFY_FURTHER', 'ed2.mp4', 'reject-all'],
    ['FLAG_MANIPULATED', 'ed3.mp4', 'resolve']
  ];
  for (const [decision, media, playMode] of branchCases) {
    await evaluate(`window.__endingPlayMode = ${JSON.stringify(playMode)}; window.__endingPlayCalls = []`);
    await click(`[data-action="SELECT_DECISION"][data-decision="${decision}"]`);
    await click('[data-action="SUBMIT_DECISION"]');
    await delay(120);
    const branch = await evaluate(`(() => {
      const video = document.querySelector('[data-ending-video]');
      return {
        finalDecision: state.finalDecision,
        src: video.querySelector('source').getAttribute('src'),
        controls: video.controls,
        volume: video.volume,
        muted: video.muted,
        open: endingVideoOpen && !endingMediaLayer.hidden,
        status: endingVideoStatus,
        calls: window.__endingPlayCalls,
        focus: document.activeElement.id,
        inPageVideo: Boolean(document.querySelector('#decision-feedback [data-ending-video]')),
        feedbackGrid: Boolean(document.querySelector('#decision-feedback .feedback-layout'))
      };
    })()`);
    assert.equal(branch.finalDecision, decision);
    assert.equal(branch.src.endsWith(media), true);
    assert.equal(branch.controls, true);
    assert.equal(branch.volume, 0.25);
    assert.equal(branch.open, true);
    assert.equal(branch.focus, 'ending-media-close');
    assert.equal(branch.inPageVideo, false);
    assert.equal(branch.feedbackGrid, false);
    if (playMode === 'reject-audible') {
      assert.deepEqual(branch.calls.map(call => call.muted), [false, true]);
      assert.equal(branch.muted, true);
      assert.equal(branch.status, 'muted');
    } else if (playMode === 'reject-all') {
      assert.deepEqual(branch.calls.map(call => call.muted), [false, true]);
      assert.equal(branch.status, 'manual');
      assert.equal(await evaluate(`!document.querySelector('[data-action="RETRY_ENDING_VIDEO"]').hidden`), true);
      await evaluate(`window.__endingPlayMode = 'resolve'`);
      await click('[data-action="RETRY_ENDING_VIDEO"]');
      assert.equal(await evaluate(`endingVideoStatus`), 'playing');
      assert.equal(await evaluate(`document.querySelector('[data-action="RETRY_ENDING_VIDEO"]').hidden`), true);
    } else {
      assert.deepEqual(branch.calls.map(call => call.muted), [false]);
      assert.equal(branch.muted, false);
      assert.equal(branch.status, 'playing');
    }
    if (decision !== 'FLAG_MANIPULATED') await click('[data-action="RESELECT_DECISION"]');
  }

  const callsBeforeLanguageSwitch = await evaluate(`window.__endingPlayCalls.length`);
  await evaluate(`window.__endingVideoNode = document.querySelector('[data-ending-video]'); dispatch('TOGGLE_LANGUAGE')`);
  const translatedWindow = await evaluate(`({ sameVideo: window.__endingVideoNode === document.querySelector('[data-ending-video]'), calls: window.__endingPlayCalls.length, title: document.getElementById('ending-media-title').textContent, expectedTitle: COPY.zh.p08.videoTitle })`);
  assert.equal(translatedWindow.sameVideo, true);
  assert.equal(translatedWindow.calls, callsBeforeLanguageSwitch);
  assert.equal(translatedWindow.title, translatedWindow.expectedTitle);
  await evaluate(`dispatch('TOGGLE_LANGUAGE')`);

  await evaluate(`document.querySelector('[data-ending-video]').dispatchEvent(new Event('ended'))`);
  assert.equal(await evaluate(`endingVideoOpen && endingVideoStatus === 'ended'`), true, 'The playback window should remain open on the final frame.');
  await click('[data-action="TOGGLE_ENDING_MUTE"]');
  assert.equal(await evaluate(`document.querySelector('[data-ending-video]').muted`), true);
  await click('[data-action="TOGGLE_ENDING_MUTE"]');
  assert.equal(await evaluate(`document.querySelector('[data-ending-video]').muted`), false);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await delay(220);
  assert.equal(await evaluate(`endingMediaLayer.hidden && !endingVideoOpen`), true);
  assert.equal(await evaluate(`document.activeElement.dataset.action`), 'OPEN_ENDING_VIDEO');

  await evaluate(`window.__endingPlayMode = 'resolve'`);
  await click('[data-action="OPEN_ENDING_VIDEO"]');
  await evaluate(`document.querySelector('[data-ending-video]').dispatchEvent(new Event('error'))`);
  assert.equal(await evaluate(`document.getElementById('ending-video-note').textContent === COPY.en.p08.mediaUnavailable`), true);
  assert.equal(await evaluate(`!document.querySelector('[data-action="RETRY_ENDING_VIDEO"]').hidden`), true);
  await send('Page.reload', { ignoreCache: true });
  await delay(500);
  const restoredDecision = await evaluate(`({ scene: state.currentScene, finalDecision: state.finalDecision, windowOpen: endingVideoOpen, layerHidden: endingMediaLayer.hidden, hasVideo: Boolean(document.querySelector('[data-ending-video]')), hasReplay: Boolean(document.querySelector('[data-action="OPEN_ENDING_VIDEO"]')) })`);
  assert.equal(restoredDecision.scene, 'P08');
  assert.equal(restoredDecision.finalDecision, 'FLAG_MANIPULATED');
  assert.equal(restoredDecision.windowOpen, false);
  assert.equal(restoredDecision.layerHidden, true);
  assert.equal(restoredDecision.hasVideo, false);
  assert.equal(restoredDecision.hasReplay, true);

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
  await evaluate(`dispatch('NAVIGATE', { scene: 'P08' }); dispatch('OPEN_ENDING_VIDEO')`);
  const reducedWindow = await evaluate(`(() => { const animationDuration = parseFloat(getComputedStyle(document.querySelector('.ending-media-window')).animationDuration); closeEndingVideo(); return { animationDuration, hiddenImmediately: endingMediaLayer.hidden }; })()`);
  assert.ok(reducedWindow.animationDuration <= 0.001, 'Reduced motion should suppress the playback window animation.');
  assert.equal(reducedWindow.hiddenImmediately, true, 'Reduced motion should close the playback window immediately.');
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
    screenshots.push(await snapshot('P08', width, height, { endingWindow: true }));
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
    decisions: 'three branches and ed1/ed2/ed3 media mapping verified',
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
