/**
 * 离线自测浏览器半（client.js）：在 Node 里模拟 window / fetch / uiWorkspace，
 * 验证「取到 activation → 补前缀 / 解归档 → uiWorkspace.openSession」这条链路。
 *
 * 运行：node test-client.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'client.js'), 'utf8');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createHarness({ activations, openImpl }) {
  const calls = { openSession: [], unarchiveSession: [], fetches: [], posted: [] };
  const uiWorkspace = {
    openSession(id) {
      calls.openSession.push(id);
      return openImpl(id, calls);
    },
    unarchiveSession(id) {
      calls.unarchiveSession.push(id);
    },
  };

  const queue = [...activations];
  const fakeFetch = async (url, init = {}) => {
    calls.fetches.push(url);
    if (url.endsWith('/log')) {
      calls.posted.push(JSON.parse(init.body ?? '{}'));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    const activation = queue.length > 0 ? queue.shift() : null;
    return { ok: true, json: async () => ({ ok: true, activation }) };
  };

  const window = {
    __ModuleLoader__: {
      load(spec) {
        window.spec = spec;
      },
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    addEventListener() {},
    removeEventListener() {},
    focus() {},
  };

  const requireFn = (name) => {
    throw new Error(`unexpected require(${name})`);
  };

  const run = new Function('window', 'fetch', 'console', source);
  run(window, fakeFetch, console);

  const disposers = [];
  const ctx = {
    get(name) {
      return name === 'uiWorkspace' ? uiWorkspace : undefined;
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
  };

  const module = window.spec.factory(requireFn);
  const disposeAll = () => {
    while (disposers.length > 0) disposers.pop()();
  };
  return { module, ctx, calls, window, disposeAll };
}

let failures = 0;
function check(name, condition, extra = '') {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name} ${extra}`);
  }
}

async function main() {
  // 情况 1：标准 session id，直接跳转。
  {
    const harness = createHarness({
      activations: [null, { sessionId: 'session-abc', kind: 'complete', at: 1 }],
      openImpl: () => undefined,
    });
    check('module id', harness.window.spec.id === 'dsh-win-notify');
    check('module name', harness.module.name === 'dsh-win-notify');
    harness.module.apply(harness.ctx);
    await sleep(1600);
    check('openSession called', harness.calls.openSession[0] === 'session-abc', JSON.stringify(harness.calls.openSession));
    check('polls /next', harness.calls.fetches.some((u) => u.endsWith('/next')));
    harness.disposeAll();
  }

  // 情况 2：id 缺 session- 前缀，第二个候选成功。
  {
    const harness = createHarness({
      activations: [{ sessionId: 'abc-123', kind: 'complete', at: 1 }],
      openImpl: (id) => {
        if (!id.startsWith('session-')) throw new Error('sessions.retain: unknown session ' + id);
      },
    });
    harness.module.apply(harness.ctx);
    await sleep(1600);
    check('prefix fallback', harness.calls.openSession.at(-1) === 'session-abc-123', JSON.stringify(harness.calls.openSession));
    harness.disposeAll();
  }

  // 情况 3：会话已归档 → unarchive 后重试成功。
  {
    const archived = new Set(['session-old']);
    const harness = createHarness({
      activations: [{ sessionId: 'session-old', kind: 'complete', at: 1 }],
      openImpl: (id, calls) => {
        if (archived.has(id)) {
          if (calls.unarchiveSession.includes(id)) {
            archived.delete(id);
            return;
          }
          throw new Error('sessions.retain: unknown session ' + id);
        }
      },
    });
    harness.module.apply(harness.ctx);
    await sleep(1600);
    check('unarchive called', harness.calls.unarchiveSession[0] === 'session-old', JSON.stringify(harness.calls.unarchiveSession));
    check('opened after unarchive', harness.calls.openSession.filter((id) => id === 'session-old').length >= 2, JSON.stringify(harness.calls.openSession));
    harness.disposeAll();
  }

  // 情况 4：dispose 之后不再轮询。
  {
    const harness = createHarness({ activations: [], openImpl: () => undefined });
    harness.module.apply(harness.ctx);
    await sleep(100);
    harness.disposeAll();
    const before = harness.calls.fetches.length;
    await sleep(1400);
    check('stops polling after dispose', harness.calls.fetches.length === before, `${before} -> ${harness.calls.fetches.length}`);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
