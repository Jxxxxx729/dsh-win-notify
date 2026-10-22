/**
 * dsh-win-notify — Windows 通知栏提醒（DeepSeek Harness Host 半）
 *
 * 触发场景：
 *   - 对话轮次正常结束      session/event → turn/end (reason.kind === 'completed')
 *   - 对话轮次异常结束      session/event → turn/end (error / blocked / max-tokens)
 *   - 等待用户选择          user-questions/request（waterfall，只旁听后 return next()）
 *   - 等待用户授权          approval/request（waterfall，只旁听后 return next()）
 *   - 需要登录 / 登录过期   deepseek-account/model-sign-in-required 等
 *
 * 点击通知的链路：
 *   toast(activationType=protocol, launch=dsh-win-notify:open?s=<sessionId>&k=<kind>)
 *     → wscript.exe 运行 runtime/activate.vbs
 *     → 把 {sessionId, kind, at} 写入 spool 目录，并启动/聚焦 DeepSeek Harness
 *     → Web 客户端半定时请求 GET /dsh-win-notify/next 取走记录
 *     → uiWorkspace.openSession(sessionId) 跳转到对应对话
 */

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-win-notify';

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.join(PACKAGE_DIR, 'runtime');
const SHOW_TOAST_SCRIPT = path.join(RUNTIME_DIR, 'show-toast.ps1');
const ACTIVATE_SCRIPT = path.join(RUNTIME_DIR, 'activate.vbs');
const REGISTER_SCRIPT = path.join(RUNTIME_DIR, 'register-protocol.ps1');

const WINDOWS_DIR = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(WINDOWS_DIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const WSCRIPT = path.join(WINDOWS_DIR, 'System32', 'wscript.exe');

const DEFAULT_PROTOCOL = 'dsh-win-notify';
const DEFAULT_APP_ID = 'com.deepseek.dsh';
const FOREGROUND_PROCESS = 'DeepSeek Harness';
const APP_EXE_NAME = 'DeepSeek Harness.exe';
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_PAYLOADS = 80;
const DEDUPE_WINDOW_MS = 1500;

const S = {
  complete: '对话已完成',
  failure: '对话异常结束',
  question: '需要你的选择',
  approval: '需要你的授权',
  signIn: '需要登录 DeepSeek 账号',
  signInBody: '请在 DeepSeek Harness 中完成登录。',
  sessionExpired: '登录已过期',
  sessionExpiredBody: '请重新登录 DeepSeek 账号后再继续。',
  unnamed: '未命名对话',
  failureBody: '本轮没有正常完成，请回到对话查看。',
  failureReasons: {
    error: '模型返回错误',
    blocked: '请求被拦截',
    'max-tokens': '输出达到长度上限',
    interrupted: '本轮被中断',
  },
  questionCount: (count) => `共 ${count} 个问题待回答`,
  approvalTool: (toolName) => `工具：${toolName}`,
};

const DEFAULT_CONFIG = {
  enabled: true,
  notifyOnTurnComplete: true,
  notifyOnTurnFailure: true,
  notifyOnQuestion: true,
  notifyOnApproval: true,
  notifyOnSignIn: true,
  skipWhenFocused: false,
  activationTtlMinutes: 120,
  sessionSummaryLength: 140,
  appId: DEFAULT_APP_ID,
  appPath: '',
  focusApp: true,
  protocol: DEFAULT_PROTOCOL,
  language: 'zh',
};

function stateDirectory() {
  const base = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
  return path.join(base, 'dsh-win-notify');
}

export function apply(ctx, config) {
  const settings = { ...DEFAULT_CONFIG, ...(config && typeof config === 'object' ? config : {}) };
  const STATE_DIR = stateDirectory();
  const SPOOL_DIR = path.join(STATE_DIR, 'spool');
  const PAYLOAD_DIR = path.join(STATE_DIR, 'payload');
  const LOG_FILE = path.join(STATE_DIR, 'notify.log');

  let pollCount = 0;
  const lastToastAt = new Map();

  // ---------------------------------------------------------------- utilities

  function ensureDirs() {
    try {
      mkdirSync(SPOOL_DIR, { recursive: true });
      mkdirSync(PAYLOAD_DIR, { recursive: true });
    } catch {
      // ignore: the toast sender reports its own failures through the log file
    }
  }

  function log(message) {
    const line = `${new Date().toISOString()} ${message}`;
    try {
      const logger = ctx.logger;
      if (logger && typeof logger.info === 'function') logger.info(line);
    } catch {
      // ignore logging failures
    }
    try {
      ensureDirs();
      if (existsSync(LOG_FILE)) {
        try {
          if (statSync(LOG_FILE).size > MAX_LOG_BYTES) truncateSync(LOG_FILE, 0);
        } catch {
          // ignore
        }
      }
      appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
    } catch {
      // ignore
    }
  }

  function normalizeText(value) {
    return String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripMarkdown(value) {
    let text = String(value ?? '');
    text = text.replace(/```[\s\S]*?```/g, ' ');
    text = text.replace(/~~~[\s\S]*?~~~/g, ' ');
    text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    text = text.replace(/`([^`]*)`/g, '$1');
    text = text.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
    text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
    text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
    text = text.replace(/^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/gm, '');
    text = text.replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, ' ');
    text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
    text = text.replace(/__([^_]+)__/g, '$1');
    text = text.replace(/~~([^~]+)~~/g, '$1');
    text = text.replace(/\*([^*]+)\*/g, '$1');
    text = text.replace(/\|/g, ' ');
    return normalizeText(text);
  }

  function truncateText(value, limit) {
    const text = normalizeText(value);
    if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
    return `${text.slice(0, Math.max(1, limit - 1))}…`;
  }

  function messageText(message) {
    if (!message || typeof message !== 'object') return '';
    const blocks = Array.isArray(message.content) ? message.content : [];
    const parts = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return normalizeText(parts.join('\n'));
  }

  function sessionEventAt(session, index) {
    try {
      if (typeof session?.eventAt !== 'function') return undefined;
      return session.eventAt(index);
    } catch {
      return undefined;
    }
  }

  function lastAssistantText(session) {
    const end = typeof session?.seq === 'number' ? session.seq : -1;
    if (end < 0) return '';
    for (let index = end; index >= 0 && index > end - 120; index -= 1) {
      const event = sessionEventAt(session, index);
      if (!event || typeof event.type !== 'string') continue;
      if (event.type === 'assistant/message') {
        const text = stripMarkdown(messageText(event.data?.message));
        if (text !== '') return text;
      }
    }
    return '';
  }

  function firstUserText(session) {
    for (let index = 0; index < 30; index += 1) {
      const event = sessionEventAt(session, index);
      if (!event || typeof event.type !== 'string') continue;
      if (event.type === 'user/message') {
        const text = messageText(event.data?.message);
        if (text !== '') return text;
      }
    }
    return '';
  }

  function sessionTitleOf(session) {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined;
      const snapshot = service && typeof service.get === 'function' ? service.get(session) : undefined;
      const title = snapshot && typeof snapshot.title === 'string' ? normalizeText(snapshot.title) : '';
      if (title !== '') return truncateText(title, 80);
    } catch {
      // fall through to the fallbacks
    }
    const firstUser = firstUserText(session);
    if (firstUser !== '') return truncateText(firstUser, 60);
    try {
      const cwd = session?.header?.cwd;
      if (typeof cwd === 'string' && cwd !== '') {
        const base = path.basename(cwd);
        if (base) return truncateText(base, 60);
      }
    } catch {
      // ignore
    }
    return S.unnamed;
  }

  function isUserConversation(session) {
    const header = session?.header;
    if (!header || typeof header !== 'object') return true;
    if (header.origin === 'subagent') return false;
    if (header.parentSession) return false;
    return true;
  }

  // ------------------------------------------------------------ toast sending

  function escapeXml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function buildToastXml({ title, lines, launch }) {
    const texts = [];
    if (title) texts.push(title);
    if (Array.isArray(lines)) {
      for (const line of lines) {
        const text = normalizeText(line);
        if (text !== '') texts.push(text);
      }
    }
    const visual = texts
      .slice(0, 4)
      .map((text) => `<text>${escapeXml(text)}</text>`)
      .join('');
    const activation = launch ? ` activationType="protocol" launch="${escapeXml(launch)}"` : '';
    return `<?xml version="1.0" encoding="utf-8"?><toast${activation}><visual><binding template="ToastGeneric">${visual}</binding></visual></toast>`;
  }

  function uriToken(value) {
    const text = String(value ?? '');
    return /^[A-Za-z0-9._~-]+$/.test(text) ? text : encodeURIComponent(text);
  }

  function buildLaunch(sessionId, kind) {
    const protocol = String(settings.protocol || DEFAULT_PROTOCOL);
    const target = kind || 'open';
    if (!sessionId) return `${protocol}:focus?k=${uriToken(target)}`;
    return `${protocol}:open?s=${uriToken(sessionId)}&k=${uriToken(target)}`;
  }

  function prunePayloads() {
    try {
      const names = readdirSync(PAYLOAD_DIR).filter((entry) => entry.endsWith('.xml'));
      if (names.length <= MAX_PAYLOADS) return;
      const files = names
        .map((entry) => {
          const file = path.join(PAYLOAD_DIR, entry);
          let modified = 0;
          try {
            modified = statSync(file).mtimeMs;
          } catch {
            modified = 0;
          }
          return { file, modified };
        })
        .sort((left, right) => left.modified - right.modified);
      for (const entry of files.slice(0, files.length - MAX_PAYLOADS)) {
        try {
          unlinkSync(entry.file);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  function spawnDetached(argv) {
    try {
      const child = spawn(POWERSHELL, argv, { windowsHide: true, detached: true, stdio: 'ignore' });
      child.on('error', (error) => log(`powershell spawn failed: ${error && error.message ? error.message : String(error)}`));
      child.unref();
      return true;
    } catch (error) {
      log(`powershell spawn failed: ${error && error.message ? error.message : String(error)}`);
      return false;
    }
  }

  function showToast({ title, lines, sessionId, kind }) {
    if (!settings.enabled) return;
    const dedupeKey = `${kind || 'open'}|${sessionId || ''}`;
    const now = Date.now();
    const previous = lastToastAt.get(dedupeKey) || 0;
    if (now - previous < DEDUPE_WINDOW_MS) return;
    lastToastAt.set(dedupeKey, now);
    try {
      ensureDirs();
      prunePayloads();
      const launch = buildLaunch(sessionId, kind);
      const xml = buildToastXml({ title, lines, launch });
      const file = path.join(PAYLOAD_DIR, `payload-${now}-${Math.random().toString(36).slice(2, 8)}.xml`);
      writeFileSync(file, xml, 'utf8');
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SHOW_TOAST_SCRIPT, '-XmlPath', file];
      const appId = normalizeText(settings.appId) || DEFAULT_APP_ID;
      args.push('-AppId', appId);
      if (settings.skipWhenFocused) args.push('-SkipIfForeground', FOREGROUND_PROCESS);
      args.push('-LogPath', LOG_FILE);
      if (spawnDetached(args)) {
        log(`toast queued kind=${kind || 'open'}${sessionId ? ` session=${sessionId}` : ''} title=${normalizeText(title)}`);
      }
    } catch (error) {
      log(`showToast failed: ${error && error.message ? error.message : String(error)}`);
    }
  }

  // -------------------------------------------------------- protocol handler

  function resolveAppExecutable() {
    const candidates = [];
    if (typeof settings.appPath === 'string' && settings.appPath.trim() !== '') candidates.push(settings.appPath.trim());
    if (typeof process.execPath === 'string' && /deepseek harness\.exe$/i.test(process.execPath)) candidates.push(process.execPath);
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) candidates.push(path.join(localAppData, 'Programs', 'DeepSeek Harness', APP_EXE_NAME));
    for (const candidate of candidates) {
      try {
        if (candidate && existsSync(candidate)) return candidate;
      } catch {
        // ignore
      }
    }
    return '';
  }

  function ensureProtocolRegistration() {
    if (!existsSync(REGISTER_SCRIPT) || !existsSync(ACTIVATE_SCRIPT)) {
      log('runtime scripts missing: activation protocol was not registered');
      return;
    }
    ensureDirs();
    const appExe = settings.focusApp ? resolveAppExecutable() : '';
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      REGISTER_SCRIPT,
      '-Protocol',
      String(settings.protocol || DEFAULT_PROTOCOL),
      '-ActivateScript',
      ACTIVATE_SCRIPT,
      '-SpoolDir',
      SPOOL_DIR,
      '-WscriptPath',
      WSCRIPT,
      '-LogPath',
      LOG_FILE,
    ];
    if (appExe !== '') args.push('-AppExe', appExe);
    else args.push('-NoAppExe');
    if (spawnDetached(args)) log(`protocol registration requested appExe=${appExe || '(none)'}`);
  }

  // ------------------------------------------------------------ turn events

  function notifyTurnEnd(session, event) {
    const reason = event?.data?.reason;
    const kind = reason && typeof reason.kind === 'string' ? reason.kind : 'completed';
    if (!settings.enabled) return;
    if (!isUserConversation(session)) return;
    if (kind === 'aborted' || kind === 'forked') return;

    const title = sessionTitleOf(session);
    if (kind === 'completed') {
      if (!settings.notifyOnTurnComplete) return;
      const summary = truncateText(lastAssistantText(session), Number(settings.sessionSummaryLength) || 0);
      const lines = [title];
      if (summary !== '') lines.push(summary);
      showToast({ title: S.complete, lines, sessionId: session?.id, kind: 'complete' });
      return;
    }

    if (!settings.notifyOnTurnFailure) return;
    const phrase = S.failureReasons[kind] || S.failureBody;
    const errorText = kind === 'error' ? truncateText(reason?.error?.message ?? reason?.error ?? '', 120) : '';
    const lines = [title, phrase];
    if (errorText !== '') lines.push(errorText);
    showToast({ title: S.failure, lines, sessionId: session?.id, kind: kind === 'max-tokens' ? 'max-tokens' : 'failure' });
  }

  function onSessionEvent(session, event) {
    try {
      if (!event || event.type !== 'turn/end') return;
      notifyTurnEnd(session, event);
    } catch (error) {
      log(`session event handler failed: ${error && error.message ? error.message : String(error)}`);
    }
  }

  function onQuestionRequest(request, next) {
    try {
      if (settings.enabled && settings.notifyOnQuestion) {
        const questions = Array.isArray(request?.questions) ? request.questions : [];
        const first = questions[0];
        if (first && typeof first === 'object') {
          const sessionId = typeof request?.agent?.id === 'string' ? request.agent.id : '';
          const heading = normalizeText([first.header, first.detail].filter((part) => typeof part === 'string' && part.trim() !== '').join(' · '));
          const lines = [];
          if (sessionId) {
            try {
              const store = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
              const liveSession = store && typeof store.get === 'function' ? store.get(sessionId) : undefined;
              if (liveSession) lines.push(sessionTitleOf(liveSession));
            } catch {
              // ignore title lookup failures
            }
          }
          if (heading !== '') lines.push(truncateText(heading, 90));
          lines.push(truncateText(first.question, 160));
          if (questions.length > 1) lines.push(S.questionCount(questions.length));
          showToast({ title: S.question, lines, sessionId, kind: 'question' });
        }
      }
    } catch (error) {
      log(`question handler failed: ${error && error.message ? error.message : String(error)}`);
    }
    return next();
  }

  function pickDisplayReason(displayReason) {
    if (!displayReason || typeof displayReason !== 'object') return '';
    const preferred = ['zh', 'zh-CN', 'en'];
    for (const key of preferred) {
      const value = displayReason[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
    for (const value of Object.values(displayReason)) {
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
    return '';
  }

  function onApprovalRequest(request, next) {
    try {
      if (settings.enabled && settings.notifyOnApproval) {
        const sessionId = request?.agent?.id ?? '';
        const lines = [];
        if (sessionId) {
          try {
            const store = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
            const liveSession = store && typeof store.get === 'function' ? store.get(sessionId) : undefined;
            if (liveSession) lines.push(sessionTitleOf(liveSession));
          } catch {
            // ignore title lookup failures
          }
        }
        const reason = normalizeText(pickDisplayReason(request?.displayReason) || request?.reason || '');
        if (reason !== '') lines.push(truncateText(reason, 140));
        const toolName = normalizeText(request?.toolName);
        if (toolName !== '') lines.push(S.approvalTool(toolName));
        showToast({ title: S.approval, lines, sessionId, kind: 'approval' });
      }
    } catch (error) {
      log(`approval handler failed: ${error && error.message ? error.message : String(error)}`);
    }
    return next();
  }

  function onSignInRequired() {
    try {
      if (settings.enabled && settings.notifyOnSignIn) {
        showToast({ title: S.signIn, lines: [S.signInBody], sessionId: '', kind: 'signin' });
      }
    } catch (error) {
      log(`sign-in handler failed: ${error && error.message ? error.message : String(error)}`);
    }
  }

  function onSessionExpired() {
    try {
      if (settings.enabled && settings.notifyOnSignIn) {
        showToast({ title: S.sessionExpired, lines: [S.sessionExpiredBody], sessionId: '', kind: 'signin' });
      }
    } catch (error) {
      log(`session-expired handler failed: ${error && error.message ? error.message : String(error)}`);
    }
  }

  // -------------------------------------------------------- activation route

  function consumeActivation() {
    ensureDirs();
    let names = [];
    try {
      names = readdirSync(SPOOL_DIR)
        .filter((entry) => /^p-.*\.json$/i.test(entry))
        .sort();
    } catch {
      return null;
    }
    const ttlMinutes = Number(settings.activationTtlMinutes);
    const ttlMs = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes * 60000 : 0;
    const now = Date.now();
    for (const entry of names) {
      const file = path.join(SPOOL_DIR, entry);
      try {
        const stats = statSync(file);
        const raw = readFileSync(file, 'utf8');
        try {
          unlinkSync(file);
        } catch {
          // ignore
        }
        if (ttlMs > 0 && now - stats.mtimeMs > ttlMs) {
          log(`dropped stale activation ${entry}`);
          continue;
        }
        const parsed = JSON.parse(raw);
        const sessionId = typeof parsed?.sessionId === 'string' ? parsed.sessionId : '';
        const kind = typeof parsed?.kind === 'string' && parsed.kind !== '' ? parsed.kind : 'open';
        return {
          sessionId,
          kind,
          at: typeof parsed?.at === 'number' ? parsed.at : Math.round(stats.mtimeMs / 1000),
        };
      } catch (error) {
        try {
          unlinkSync(file);
        } catch {
          // ignore
        }
        log(`activation read failed ${entry}: ${error && error.message ? error.message : String(error)}`);
      }
    }
    return null;
  }

  function writeJson(response, status, value) {
    try {
      const body = JSON.stringify(value);
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
    } catch (error) {
      log(`response failed: ${error && error.message ? error.message : String(error)}`);
    }
  }

  function handleNext(request, response) {
    try {
      const method = typeof request?.method === 'string' ? request.method.toUpperCase() : 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        writeJson(response, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      pollCount += 1;
      if (pollCount <= 5 || pollCount % 500 === 0) log(`client polling (${pollCount} requests)`);
      let activation = null;
      try {
        activation = consumeActivation();
      } catch (error) {
        log(`consume activation failed: ${error && error.message ? error.message : String(error)}`);
      }
      writeJson(response, 200, { ok: true, activation });
    } catch (error) {
      log(`activation route failed: ${error && error.message ? error.message : String(error)}`);
    }
  }

  function listKnownSessions() {
    const out = [];
    try {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
      if (!sessions || typeof sessions.list !== 'function') {
        log(`sessions service unavailable: ${sessions === undefined ? 'undefined' : typeof sessions}`);
        return out;
      }
      const items = sessions.list();
      log(`sessions store reports ${Array.isArray(items) ? items.length : 'non-array'} sessions`);
      let titleService;
      try {
        titleService = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined;
      } catch {
        titleService = undefined;
      }
      for (const item of Array.isArray(items) ? items : []) {
        const id = typeof item?.id === 'string' ? item.id : '';
        if (id === '') continue;
        let title = '';
        try {
          const snapshot = titleService && typeof titleService.get === 'function' ? titleService.get(item) : undefined;
          if (snapshot && typeof snapshot.title === 'string') title = snapshot.title;
        } catch {
          title = '';
        }
        out.push({ id, title });
      }
    } catch (error) {
      log(`list sessions failed: ${error && error.message ? error.message : String(error)}`);
    }
    return out.slice(0, 60);
  }

  function handleStatus(request, response) {
    try {
      let spool = 0;
      let payload = 0;
      try {
        spool = readdirSync(SPOOL_DIR).filter((entry) => /^p-.*\.json$/i.test(entry)).length;
      } catch {
        spool = 0;
      }
      try {
        payload = readdirSync(PAYLOAD_DIR).filter((entry) => entry.endsWith('.xml')).length;
      } catch {
        payload = 0;
      }
      writeJson(response, 200, {
        ok: true,
        platform: process.platform,
        settings,
        stateDir: STATE_DIR,
        logFile: LOG_FILE,
        appExe: resolveAppExecutable(),
        pollCount,
        pendingActivations: spool,
        payloadFiles: payload,
        sessions: listKnownSessions(),
      });
    } catch (error) {
      log(`status route failed: ${error && error.message ? error.message : String(error)}`);
    }
  }

  async function handleClientLog(request, response) {
    try {
      const chunks = [];
      await new Promise((resolve) => {
        request.on('data', (chunk) => {
          if (chunks.length < 64) chunks.push(Buffer.from(chunk));
        });
        request.on('end', resolve);
        request.on('error', resolve);
      });
      const text = Buffer.concat(chunks).toString('utf8').slice(0, 2000).replace(/\s+/g, ' ');
      if (text !== '') log(`[client] ${text}`);
      writeJson(response, 200, { ok: true });
    } catch (error) {
      log(`client log failed: ${error && error.message ? error.message : String(error)}`);
    }
  }

  function mountActivationRoutes() {
    let webServer;
    try {
      webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
    } catch {
      webServer = undefined;
    }
    if (!webServer || typeof webServer.register !== 'function') {
      log('webServer service unavailable: click-to-open will fall back to focusing the app only');
      return () => {};
    }
    // 路由基名固定，不改用 settings.protocol：浏览器半写死了 '/dsh-win-notify/*'，
    // protocol 只是 Windows 协议名，改它不应该让点击跳转断掉。
    const base = DEFAULT_PROTOCOL;
    const disposers = [];
    try {
      disposers.push(webServer.register({ kind: 'exact', path: `/${base}/next`, handler: handleNext }));
      disposers.push(webServer.register({ kind: 'exact', path: `/${base}/status`, handler: handleStatus }));
      disposers.push(webServer.register({ kind: 'exact', path: `/${base}/log`, handler: handleClientLog }));
    } catch (error) {
      log(`activation route registration failed: ${error && error.message ? error.message : String(error)}`);
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // ignore
        }
      }
    };
  }

  // ----------------------------------------------------------- registrations

  if (process.platform !== 'win32') {
    log(`windows only: notifications disabled on ${process.platform}`);
    return;
  }

  ctx.effect(() => {
    log(`activated appId=${settings.appId} stateDir=${STATE_DIR}`);
    ensureDirs();
    ensureProtocolRegistration();
    return () => log('disposed');
  }, 'dsh-win-notify: windows runtime');

  ctx.effect(() => ctx.on('session/event', onSessionEvent), 'dsh-win-notify: turn notifications');
  // 选择/授权是 waterfall 事件：内置 UI 应答者一旦认领就不再往下走，所以本插件
  // 必须 prepend 抢在它前面「只观察、再 next() 委托」，不能影响原决策。
  ctx.effect(() => ctx.on('user-questions/request', onQuestionRequest, { prepend: true }), 'dsh-win-notify: question notifications');
  ctx.effect(() => ctx.on('approval/request', onApprovalRequest, { prepend: true }), 'dsh-win-notify: approval notifications');
  ctx.effect(() => ctx.on('deepseek-account/model-sign-in-required', onSignInRequired), 'dsh-win-notify: sign-in notifications');
  ctx.effect(() => ctx.on('deepseek-account/session-expired', onSessionExpired), 'dsh-win-notify: session notifications');
  ctx.effect(() => mountActivationRoutes(), 'dsh-win-notify: activation routes');
}
