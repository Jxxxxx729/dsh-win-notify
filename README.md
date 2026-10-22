# dsh-win-notify

在 Windows 通知栏提醒你 DSH 的状态变化，点击通知即可跳回对应对话。

DeepSeek Harness（DSH）桌面端的 Host + Web 双半插件，仅支持 Windows。

支持的通知：

| 时机 | 通知标题 | 点击后 |
| --- | --- | --- |
| 一轮对话正常结束 | 对话已完成 | 跳回该对话 |
| 一轮对话异常结束（报错 / 被阻塞 / 超长截断） | 对话异常结束 | 跳回该对话 |
| 弹出需要你选择的问题 | 需要你的选择 | 跳回该对话 |
| 弹出需要你授权的操作 | 需要你的授权 | 跳回该对话 |
| 需要登录 DeepSeek 账号 / 登录过期 | 需要登录 DeepSeek 账号 | 打开 DSH |

通知以 **DeepSeek Harness** 的名义显示（Windows 应用 ID `com.deepseek.dsh`），带上应用图标，不经过 PowerShell 的身份。

## 安装

1. 克隆到任意本地目录（不必放进 DSH 工作区）：

   ```powershell
   git clone https://github.com/Jxxxxx729/dsh-win-notify.git "$env:USERPROFILE\dsh-win-notify"
   ```

2. 打开 DSH 的「插件」页，用**本地 bundle 目录**安装上一步的目录（目录里有 `package.json` 和 `cordis.patch.yml`）。安装后出现条目 `dsh-win-notify`，启用即生效：插件会自己注册 `dsh-win-notify:` 协议、创建 `%LOCALAPPDATA%\dsh-win-notify\` 状态目录。
3. 首次安装后刷新一次 GUI 页面，让 Web 客户端半加载；之后启停插件都不需要再刷新。

要求：Windows 10/11 + DSH 桌面版（通知身份依赖桌面应用的 AppUserModelID `com.deepseek.dsh`）。在非桌面版（纯 `dsh web`）里仍会发通知，但点通知只能打开 DSH 而无法靠应用标识显示图标。

## 工作原理

1. Host 半监听 `session/event` 的 `turn/end`、`user-questions/request`、`approval/request`、`deepseek-account/*` 事件。
2. 命中后渲染一条 Toast XML 并调用 `runtime/show-toast.ps1`（WinRT `ToastNotificationManager`）发出通知；Toast 的 `activationType="protocol"` 指向 `dsh-win-notify:open?s=<会话 id>&k=<类型>`。
3. 点击通知 → Windows 调 `runtime/activate.vbs`：把 `{sessionId, kind, at}` 写入 spool 目录，并启动 / 聚焦 DeepSeek Harness。
4. Web 客户端半每 1.2 秒 `GET /dsh-win-notify/next` 取走这条记录，调用官方 `uiWorkspace.openSession(sessionId)` 把界面切到该对话。

## 配置

在 profile 的 patch 里给 `dsh-win-notify` 条目加 `config`：

```yaml
- id: dsh-win-notify
  config:
    skipWhenFocused: false      # 窗口在前台时也提醒
    activationTtlMinutes: 120   # 超过这个时间的点击记录直接丢弃
    sessionSummaryLength: 140   # 通知正文里摘要的最大字符数
    notifyOnTurnComplete: true
    notifyOnTurnFailure: true
    notifyOnQuestion: true
    notifyOnApproval: true
    notifyOnSignIn: true
```

`appPath` 一般不用填：插件会自己找 `DeepSeek Harness.exe`。

## 状态与日志

- 目录：`%LOCALAPPDATA%\dsh-win-notify\`
  - `spool\` 点击记录（客户端取走即删）
  - `payload\` 已发送的 Toast XML（保留最近 80 个）
  - `notify.log` 日志
- 自检：`GET http://<GUI 地址>/dsh-win-notify/status` 返回当前配置、spool 待处理数与日志路径。
- 通知自检（不依赖任何对话事件）：在 `%LOCALAPPDATA%\dsh-win-notify\` 里新建空文件 `selftest.flag`，再到「插件」里把 `dsh-win-notify` 关掉再打开；重新激活时会立刻发一条「通知自检」通知，用来确认「插件 → powershell → 通知栏」整条链路。
- 排查用日志行：
  - `toast queued kind=... title=...`：插件收到了事件并已生成 payload；
  - `toast exited code=0`：powershell 正常结束（脚本内部还会往同一个 `notify.log` 追加一行 `shown`）；
  - `toast exited code=1` 或 `stderr=...`：发送失败，`stderr` 与脚本写的 `error: ...` 会给出原因。

## 注册表

插件启动时会为当前用户注册 `dsh-win-notify:` 协议（`HKCU\Software\Classes\dsh-win-notify`），命令指向
`wscript.exe //nologo <插件目录>\runtime\activate.vbs "%1" <spool 目录> "<DeepSeek Harness.exe>"`。
这一步只写 HKCU，不需要管理员权限。

## 注意

- Windows「专注助手 / 勿扰模式」会压掉通知，需要允许 DeepSeek Harness 的通知。
- 只对用户会话提醒，子代理（subagent）会话结束不提醒。
- 如果 GUI 地址或端口变了无需改配置：客户端半用的是同源相对路径。
- `user-questions/request` / `approval/request` 是 waterfall 事件，内置 UI 应答者一旦认领就不会再往下走，所以本插件用 `{ prepend: true }` 抢在它之前**只观察并立刻 `return next()`**，不参与决策；这也是修改这两个监听器时最容易被忽略的一点。
- 改动 `client.js` 后需要刷新一次 GUI 页面才会生效（Host 半可以用插件启停热重载，浏览器半不会自动重载）。
- 浏览器半可以离线自测：`node test-client.mjs`（用假的 `window` / `fetch` / `uiWorkspace` 覆盖补前缀、解归档、dispose 停止轮询四种情况）。
- 发通知用的是**非 detached** 的 `powershell.exe` 子进程并接住 `stderr`、记录退出码。早先试过 `detached: true` + `stdio: 'ignore'`：桌面端重启后那种子进程会静默地不执行脚本（日志里只有 `toast queued`、没有 `shown`，通知也不弹），而且没有任何报错可查。不要改回 detached。
- 路由用 `ctx.inject(['webServer'], (hostCtx) => ...)` 挂载：桌面端冷启动时插件可能比 `webServer` 服务先加载，直接 `ctx.get('webServer')` 会拿到 `undefined`，一旦错过就再也不会重试，点击跳转和客户端轮询会一起失效。
- 通知与点击链路里的路由基名固定为 `/dsh-win-notify/*`；`protocol` 配置只影响 Windows 协议名，不会让已打开的页面失联。

## 更新记录

- **1.0.1**（2026-10-22）：修复桌面端重启后「别的对话需要授权/选择却没有通知」以及点击跳转失效的问题。
  - 原因一：发通知原先用 `detached: true` + `stdio: 'ignore'` 的 powershell 子进程，桌面端重启后这类子进程会静默地不执行脚本 —— 日志里只有 `toast queued`、没有 `shown`，也没有任何报错可查。现改为非 detached 子进程，接住 `stderr` 并记录退出码。
  - 原因二：插件可能比 `webServer` 服务先加载，`ctx.get('webServer')` 拿到 `undefined` 后就再也不会重试，客户端轮询与点击跳转一起失效。现改用 `ctx.inject(['webServer'], ...)` 在服务就绪时挂载路由。
  - 另新增 `selftest.flag` 自检通知（见「状态与日志」），用来单独验证「插件 → powershell → 通知栏」这条链路。

## 许可

[MIT](LICENSE)
