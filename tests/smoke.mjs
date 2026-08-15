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
fs.mkdirSync(artifacts, { recursive: true });

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
    overflowingButtons: [...document.querySelectorAll('button')].filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.textContent.trim())
  })`);
  assert.equal(layout.scene, scene);
  assert.ok(layout.scrollWidth <= layout.viewport, `${scene} has horizontal overflow at ${width}px`);
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

  const initial = await evaluate(`({ scene: state.currentScene, evidence: state.evidence, external: [...document.querySelectorAll('[src],[href]')].map(element => element.src || element.href).filter(value => /^https?:/.test(value)) })`);
  assert.equal(initial.scene, 'P00');
  assert.deepEqual(initial.evidence, []);
  assert.deepEqual(initial.external, []);

  await delay(3800);
  assert.equal(await evaluate(`!document.getElementById('boot-action').hidden`), true, 'P00 enter control should appear after typing.');
  await click('[data-action="ENTER_SYSTEM"]');
  assert.equal(await evaluate('state.currentScene'), 'P01');

  await click('[data-action="START_CASE"]');
  assert.equal(await evaluate('state.currentScene'), 'P02');
  assert.deepEqual(await evaluate('state.evidence'), []);

  await click('[data-action="TOGGLE_LANGUAGE"]');
  assert.equal(await evaluate('state.language'), 'zh');
  assert.equal(await evaluate(`document.getElementById('scene-title').textContent`), '紧急邮件');
  await click('[data-action="TOGGLE_LANGUAGE"]');

  await click('[data-action="OPEN_REPLY"]');
  await click('input[name="reply-choice"][value="1"]');
  assert.equal(await evaluate('state.replyChoice'), 1);
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
  assert.equal(await evaluate('state.currentScene'), 'P03');
  await click('[data-action="SAVE_EVIDENCE"][data-evidence="A"]');
  await click('[data-action="CLOSE_MODAL"]');
  await click('[data-action="SAVE_EVIDENCE"][data-evidence="A"]');
  await click('[data-action="CLOSE_MODAL"]');
  assert.deepEqual(await evaluate('state.evidence'), ['E', 'A']);

  await send('Page.reload', { ignoreCache: true });
  await delay(500);
  const restored = await evaluate(`({ scene: state.currentScene, evidence: state.evidence, replySent: state.replySent })`);
  assert.equal(restored.scene, 'P03');
  assert.deepEqual(restored.evidence, ['E', 'A']);
  assert.equal(restored.replySent, true);

  await click('[data-action="SHOW_VIDEO_NOTICE"]');
  assert.equal(await evaluate(`document.getElementById('dialog-title').textContent`), 'CONTENT VERIFICATION NOTICE');
  await click('[data-action="CLOSE_MODAL"]');
  await click('[data-action="SHOW_SKEPTIC"]');
  assert.equal(await evaluate(`document.getElementById('dialog-title').textContent`), 'BURIED SIGNAL');
  await click('[data-action="CLOSE_MODAL"]');

  await click('[data-action="UNLOCK_SEARCH"]');
  assert.equal(await evaluate('state.maxUnlockedScene'), 'P04');
  await click('[data-action="CLOSE_MODAL"]');

  await evaluate(`dispatch('TOGGLE_LANGUAGE')`);
  assert.equal(await evaluate('state.language'), 'zh');
  await evaluate(`dispatch('NAVIGATE', { scene: 'P00' })`);
  assert.equal(await evaluate(`document.getElementById('boot-copy').textContent.includes('你的任务是核实')`), true);
  await evaluate(`dispatch('NAVIGATE', { scene: 'P01' })`);
  assert.equal(await evaluate(`document.getElementById('scene-title').textContent.replace(/\s+/g, '')`), '她从未发布过。');
  await evaluate(`dispatch('NAVIGATE', { scene: 'P02' })`);
  assert.equal(await evaluate(`document.querySelector('.mail-body').textContent.includes('早前一次公开直播')`), true);
  await evaluate(`dispatch('NAVIGATE', { scene: 'P03' })`);
  assert.equal(await evaluate(`document.querySelector('.comments').textContent.includes('光线和背景不匹配')`), true);
  await evaluate(`dispatch('TOGGLE_LANGUAGE')`);
  assert.equal(await evaluate('state.language'), 'en');

  const screenshots = [];
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
    for (const scene of ['P00', 'P01', 'P02', 'P03']) screenshots.push(await snapshot(scene, width, height));
  }

  await evaluate(`dispatch('OPEN_RESET')`);
  await click('[data-action="CONFIRM_RESET"]');
  const reset = await evaluate(`({ scene: state.currentScene, evidence: state.evidence, language: state.language })`);
  assert.equal(reset.scene, 'P00');
  assert.deepEqual(reset.evidence, []);
  assert.equal(reset.language, 'en');

  assert.deepEqual(exceptions, [], `Runtime exceptions: ${exceptions.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join('\n')}`);

  console.log(JSON.stringify({
    passed: true,
    flow: 'P00 -> P01 -> P02 -> P03 -> P04 unlocked',
    persistence: 'reply + evidence restored after reload',
    evidence: ['E', 'A'],
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
