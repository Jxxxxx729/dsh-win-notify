/*
 * dsh-win-notify — Web 客户端半。
 *
 * 通知被点击后，Host 半（经 dsh-win-notify: 协议 + activate.vbs）会把
 * { sessionId, kind, at } 写进 spool 目录。本模块定时 GET /dsh-win-notify/next
 * 取走这条记录，然后用官方导航服务 uiWorkspace.openSession(sessionId)
 * 把界面切到发出通知的那个对话。
 */
window.__ModuleLoader__.load({
  id: 'dsh-win-notify',
  factory: (require) => {
    const BASE = '/dsh-win-notify';
    const POLL_INTERVAL_MS = 1200;

    // 只 probe，不硬读 ctx 上未注入的服务，否则 Cordis 会挡住插件激活。
    function probeService(ctx, serviceName) {
      if (!ctx) return undefined;
      if (typeof ctx.get === 'function') {
        try {
          const found = ctx.get(serviceName);
          if (found !== undefined) return found;
        } catch {
          return undefined;
        }
      }
      const reflect = ctx.reflect;
      if (reflect && typeof reflect.get === 'function') {
        try {
          return reflect.get(serviceName);
        } catch {
          return undefined;
        }
      }
      return undefined;
    }

    function diag(message) {
      try {
        return fetch(`${BASE}/log`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ at: Date.now(), message: String(message) }),
        }).catch(() => undefined);
      } catch {
        return undefined;
      }
    }

    function focusWindow() {
      try {
        window.focus();
      } catch {
        // ignore: the desktop activation already focused the window
      }
    }

    // 会话 id 正常形如 session-<uuid>。缺失前缀时补一次，避免旧记录打不开。
    function candidateIds(sessionId) {
      if (sessionId.startsWith('session-')) return [sessionId];
      return [sessionId, `session-${sessionId}`];
    }

    async function tryOpen(uiWorkspace, sessionId) {
      for (const id of candidateIds(sessionId)) {
        try {
          uiWorkspace.openSession(id);
          return true;
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          // 归档会话：先取消归档（可能是异步的）再重试一次。
          if (/unknown session/i.test(message) && typeof uiWorkspace.unarchiveSession === 'function') {
            try {
              const pending = uiWorkspace.unarchiveSession(id);
              if (pending && typeof pending.then === 'function') await pending;
              uiWorkspace.openSession(id);
              return true;
            } catch {
              // fall through to next candidate
            }
          }
        }
      }
      return false;
    }

    function openConversation(ctx, sessionId) {
      const uiWorkspace = probeService(ctx, 'uiWorkspace');
      if (!uiWorkspace || typeof uiWorkspace.openSession !== 'function') {
        diag('uiWorkspace.openSession unavailable');
        return false;
      }
      return tryOpen(uiWorkspace, sessionId).then((opened) => {
        if (!opened) diag(`openSession failed for ${sessionId}`);
        return opened;
      });
    }

    async function pollOnce(ctx, onError) {
      let response;
      try {
        response = await fetch(`${BASE}/next`, {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json' },
        });
      } catch (error) {
        onError(`fetch failed: ${error && error.message ? error.message : String(error)}`);
        return;
      }
      if (!response.ok) {
        onError(`fetch status ${response.status}`);
        return;
      }
      let data;
      try {
        data = await response.json();
      } catch (error) {
        onError(`bad json: ${error && error.message ? error.message : String(error)}`);
        return;
      }
      const activation = data && data.ok ? data.activation : null;
      if (!activation) return;
      const sessionId = typeof activation.sessionId === 'string' ? activation.sessionId : '';
      diag(`activation ${JSON.stringify(activation)}`);
      if (sessionId === '') {
        focusWindow();
        return;
      }
      // 让刚被激活的窗口先完成一次布局，再执行整段导航。
      window.setTimeout(() => {
        void openConversation(ctx, sessionId);
        focusWindow();
      }, 150);
    }

    const notifyModule = {
      name: 'dsh-win-notify',
      apply(ctx) {
        let timer = null;
        let busy = false;
        let disposed = false;
        let errorsReported = 0;

        const onError = (message) => {
          errorsReported += 1;
          if (errorsReported <= 3) diag(`poll error: ${message}`);
        };

        const tick = () => {
          if (disposed || busy) return;
          busy = true;
          pollOnce(ctx, onError)
            .catch(() => undefined)
            .finally(() => {
              busy = false;
            });
        };

        ctx.effect(() => {
          timer = window.setInterval(tick, POLL_INTERVAL_MS);
          tick();
          const onFocus = () => tick();
          window.addEventListener('focus', onFocus);
          diag('polling started');
          return () => {
            disposed = true;
            diag('polling stopped');
            if (timer !== null) window.clearInterval(timer);
            timer = null;
            window.removeEventListener('focus', onFocus);
          };
        }, 'dsh-win-notify: activation polling');
      },
    };

    return notifyModule;
  },
});
