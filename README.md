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
- 通知与点击链路里的路由基名固定为 `/dsh-win-notify/*`；`protocol` 配置只影响 Windows 协议名，不会让已打开的页面失联。

## 验收记录

- 通知身份：AppId `com.deepseek.dsh`，通知栏显示应用名「DeepSeek Harness」+ 应用图标。
- 对话完成：真实 `turn/end`（completed）触发 `toast queued kind=complete`，payload 含会话标题与摘要。
- 点击跳转：点击通知 → `activate.vbs` 写 spool → 客户端轮询 `openSession` → 窗口标题切换为目标对话（已用两个不同会话双向验证）。
- 需要选择：真实 `user-questions/request` 触发 `toast queued kind=question`，payload 含会话标题 / 问题小标题 / 问题正文。
- 需要授权、需要登录两条：本机当前策略下无法触发真实事件（文件策略为 danger-full-access，没有可升级的沙箱授权；账号未过期），代码路径与「需要选择」相同（同一 waterfall + prepend 机制）。

## 许可

[MIT](LICENSE)
