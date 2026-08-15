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

assert.equal(/<audio\b/i.test(htmlSource), false, 'Audio elements must remain deferred.');
assert.equal(/<video\b/i.test(htmlSource), false, 'Video elements must remain deferred.');
assert.equal(htmlSource.includes('AudioContext'), false, 'Web Audio must remain deferred.');
assert.equal(/materials\/(?:sound|videos)/i.test(htmlSource), false, 'Media material files must not be referenced.');

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
  for (let attempt = 0; attempt < 50; attempt += 1) {
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
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result.value;
}

async function click(selector) {
  const clicked = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return false; element.click(); return true; })()`);
  assert.equal(clicked, true, `Expected clickable control: ${selector}`);
  await delay(80);
}

async function snapshot(scene, width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600
  });
  await evaluate(`dispatch('NAVIGATE', { scene: ${JSON.stringify(scene)} })`);
  await delay(120);
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
  const filename = `${scene}-${width}x${height}.png`;
  fs.writeFileSync(path.join(artifacts, filename), Buffer.from(image.data, 'base64'));
  return filename;
}

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await delay(300);

  const initial = await evaluate(`({ scene: state.currentScene, evidence: state.evidence, version: state.version, external: [...document.querySelectorAll('[src],[href]')].map(element => element.src || element.href).filter(value => /^https?:/.test(value)) })`);
  assert.equal(initial.scene, 'P00');
  assert.equal(initial.version, 2);
  assert.deepEqual(initial.evidence, []);
  assert.deepEqual(initial.external, []);

  await evaluate(`localStorage.setItem('behind-the-filter.case001.v1', JSON.stringify({ version: 1, language: 'zh', currentScene: 'P03', maxUnlockedScene: 'P04', evidence: ['A', 'E'], replyChoice: 1, replySent: true, openingSeen: true }))`);
  await send('Page.reload', { ignoreCache: true });
  await delay(400);
  const migrated = await evaluate(`({ version: state.version, language: state.language, scene: state.currentScene, maxScene: state.maxUnlockedScene, evidence: state.evidence, replySent: state.replySent, v2Stored: Boolean(localStorage.getItem('behind-the-filter.case001.v2')) })`);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.language, 'zh');
  assert.equal(migrated.scene, 'P03');
  assert.equal(migrated.maxScene, 'P04');
  assert.deepEqual(migrated.evidence, ['A', 'E']);
  assert.equal(migrated.replySent, true);
  assert.equal(migrated.v2Stored, true);
  await evaluate(`dispatch('CONFIRM_RESET')`);

  await delay(5200);
  assert.equal(await evaluate(`!document.getElementById('boot-action').hidden`), true, 'P00 enter control should appear after typing.');
  await click('[data-action="ENTER_SYSTEM"]');
  assert.equal(await evaluate('state.currentScene'), 'P01');
  await click('[data-action="START_CASE"]');
  assert.equal(await evaluate('state.currentScene'), 'P02');

  await click('[data-action="OPEN_REPLY"]');
  await click('input[name="reply-choice"][value="1"]');
  await evaluate(`document.querySelector('[data-reply-form]').requestSubmit()`);
  await delay(80);
  assert.equal(await evaluate('state.replySent'), true);
  assert.equal(await evaluate(`document.activeElement.id`), 'dialog-close');
  assert.equal(await evaluate('app.inert'), true);
  await click('[data-action="CLOSE_MODAL"]');
  assert.equal(await evaluate('app.inert'), false);

  await click('[data-action="SAVE_EVIDENCE"][data-evidence="E"]');
  await click('[data-action="CLOSE_MODAL"]');
  assert.deepEqual(await evaluate('state.evidence'), ['E']);
  await click('[data-action="OPEN_POST"]');
  await click('[data-action="SAVE_EVIDENCE"][data-evidence="A"]');
  await click('[data-action="CLOSE_MODAL"]');
  await click('[data-action="SAVE_EVIDENCE"][data-evidence="A"]');
  await click('[data-action="CLOSE_MODAL"]');
  assert.deepEqual(await evaluate('state.evidence'), ['E', 'A']);

  await click('[data-action="SHOW_VIDEO_NOTICE"]');
  assert.equal(await evaluate(`document.getElementById('dialog-title').textContent`), 'CONTENT VERIFICATION NOTICE');
  await click('[data-action="CLOSE_MODAL"]');
  await click('[data-action="UNLOCK_SEARCH"]');
  assert.equal(await evaluate('state.currentScene'), 'P04');
  assert.equal(await evaluate('state.maxUnlockedScene'), 'P04');
  assert.equal(await evaluate(`document.querySelector('.search-query-bar input').readOnly`), true);
  assert.equal(await evaluate(`document.querySelectorAll('[data-action="SELECT_SEARCH_QUERY"]').length`), 5);
  assert.deepEqual(await evaluate('state.visitedQueries'), ['maya']);

  for (const query of ['uploader', 'headline', 'police']) {
    await click(`[data-action="SELECT_SEARCH_QUERY"][data-query="${query}"]`);
    await click(`[data-action="OPEN_SEARCH_RESULT"][data-query="${query}"]`);
    await click('[data-action="CLOSE_MODAL"]');
  }
  await click('[data-action="SELECT_SEARCH_QUERY"][data-query="festival"]');
  assert.deepEqual((await evaluate('state.visitedQueries')).sort(), ['festival', 'headline', 'maya', 'police', 'uploader']);
  await click('[data-action="OPEN_SEARCH_RESULT"][data-query="festival"]');
  assert.equal(await evaluate('state.currentScene'), 'P05');
  assert.equal(await evaluate(`document.querySelector('[data-action="OPEN_SOURCE_TRACE"]').disabled`), true);
  assert.equal(await evaluate(`document.querySelector('[data-evidence="B"]') === null`), true);

  await click('[data-action="INSPECT_ARCHIVE"]');
  assert.equal(await evaluate('state.archiveRecordInspected'), true);
  assert.equal(await evaluate(`Boolean(document.getElementById('source-match'))`), true);
  await click('[data-action="SAVE_EVIDENCE"][data-evidence="B"]');
  await click('[data-action="CLOSE_MODAL"]');
  await click('[data-action="SAVE_EVIDENCE"][data-evidence="B"]');
  await click('[data-action="CLOSE_MODAL"]');
  assert.deepEqual(await evaluate('state.evidence'), ['E', 'A', 'B']);
  await click('[data-action="OPEN_SOURCE_TRACE"]');
  assert.equal(await evaluate('state.currentScene'), 'P06');
  assert.equal(await evaluate(`document.querySelectorAll('[data-action="TOGGLE_TRACE_NODE"]').length`), 7);

  await click('[data-action="TOGGLE_TRACE_NODE"][data-node="first-repost"]');
  assert.equal(await evaluate(`document.querySelector('[data-node="first-repost"]').getAttribute('aria-expanded')`), 'true');
  await click('[data-action="SAVE_EVIDENCE"][data-evidence="D"]');
  await click('[data-action="CLOSE_MODAL"]');
  await click('[data-action="SAVE_EVIDENCE"][data-evidence="D"]');
  await click('[data-action="CLOSE_MODAL"]');
  await click('[data-action="OPEN_UPLOADER_ANALYSIS"]');
  assert.equal(await evaluate('state.uploaderAnalysisOpened'), true);
  await click('[data-action="SAVE_EVIDENCE"][data-evidence="C"]');
  await click('[data-action="CLOSE_MODAL"]');
  await click('[data-action="SAVE_EVIDENCE"][data-evidence="C"]');
  await click('[data-action="CLOSE_MODAL"]');
  assert.deepEqual(await evaluate('state.evidence'), ['E', 'A', 'B', 'D', 'C']);

  await send('Page.reload', { ignoreCache: true });
  await delay(500);
  const restored = await evaluate(`({ scene: state.currentScene, evidence: state.evidence, visited: state.visitedQueries, inspected: state.archiveRecordInspected, analyzed: state.uploaderAnalysisOpened })`);
  assert.equal(restored.scene, 'P06');
  assert.deepEqual(restored.evidence, ['E', 'A', 'B', 'D', 'C']);
  assert.equal(restored.visited.length, 5);
  assert.equal(restored.inspected, true);
  assert.equal(restored.analyzed, true);

  await click('[data-action="UNLOCK_BOARD"]');
  assert.equal(await evaluate('state.maxUnlockedScene'), 'P07');
  assert.equal(await evaluate(`document.getElementById('dialog-title').textContent`), 'TRACE EVIDENCE BOARD ACCESS GRANTED');
  await click('[data-action="CLOSE_MODAL"]');

  await evaluate(`dispatch('TOGGLE_LANGUAGE')`);
  assert.equal(await evaluate('state.language'), 'zh');
  for (const scene of ['P00', 'P01', 'P02', 'P03', 'P04', 'P05', 'P06']) {
    await evaluate(`dispatch('NAVIGATE', { scene: ${JSON.stringify(scene)} })`);
    const translated = await evaluate(`(() => {
      const key = ${JSON.stringify(scene.toLowerCase())};
      const root = key === 'p00' ? document.getElementById('boot-copy') : document.getElementById('scene-title');
      const expected = key === 'p00' ? COPY.zh.p00.text.slice(0, 8) : key === 'p05' ? COPY.zh.p05.university : COPY.zh[key].title;
      return root.textContent.replace(/\\s+/g, '').includes(expected.replace(/\\s+/g, ''));
    })()`);
    assert.equal(translated, true, `${scene} should render Chinese copy.`);
  }
  await evaluate(`dispatch('TOGGLE_LANGUAGE')`);
  assert.equal(await evaluate('state.language'), 'en');

  const screenshots = [];
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
    for (const scene of ['P00', 'P01', 'P02', 'P03', 'P04', 'P05', 'P06']) screenshots.push(await snapshot(scene, width, height));
  }

  await evaluate(`dispatch('OPEN_RESET')`);
  await click('[data-action="CONFIRM_RESET"]');
  const reset = await evaluate(`({ scene: state.currentScene, evidence: state.evidence, language: state.language, v1: localStorage.getItem('behind-the-filter.case001.v1'), v2: localStorage.getItem('behind-the-filter.case001.v2') })`);
  assert.equal(reset.scene, 'P00');
  assert.deepEqual(reset.evidence, []);
  assert.equal(reset.language, 'en');
  assert.equal(reset.v1, null);
  assert.equal(reset.v2, null);

  assert.deepEqual(exceptions, [], `Runtime exceptions: ${exceptions.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join('\n')}`);

  console.log(JSON.stringify({
    passed: true,
    flow: 'P00 -> P01 -> P02 -> P03 -> P04 -> P05 -> P06 -> P07 unlocked',
    migration: 'v1 state preserved and stored as v2',
    persistence: 'five queries + evidence B/C/D restored after reload',
    mediaDeferred: true,
    screenshots: screenshots.map(filename => path.join(artifacts, filename))
  }, null, 2));
} finally {
  socket.close();
  if (browser.exitCode === null) {
    browser.kill();
    await Promise.race([
      new Promise(resolve => browser.once('exit', resolve)),
      delay(1500)
    ]);
  }
  if (profile.startsWith(os.tmpdir())) {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    } catch {
      // Windows may retain transient Chrome lock files; they are confined to the OS temp directory.
    }
  }
}
