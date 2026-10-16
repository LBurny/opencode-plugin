# oc.zoom — OpenCode 桌面版缩放插件

为 **OpenCode Desktop V2**(Electron 桌面端,验证版本 2.0.30)提供缩放控制,解决两个问题:

1. **缩放不记忆** —— 内置缩放(Ctrl+= / Ctrl+- / Ctrl+0、View 菜单、Ctrl+滚轮)每次启动都会被重置回 100%;
2. **比例不可控** —— 内置步进固定为 ±20%,不能指定任意比例。

本插件通过 OpenCode 桌面端的 GUI 扩展机制(`opencode.gui-extension/1`)实现,`main` 脚本运行在
Electron 主进程,不修改应用本体文件。

## 功能

| 功能 | 说明 |
| --- | --- |
| 记住缩放 | 完全退出再打开后自动恢复上次的缩放比例,新开的窗口同样生效 |
| 精确设置 | View 菜单 → **缩放设置** 弹出对话框:任意百分比、快捷预设(± 按钮按所选**步进** 1%/2%/5%/10% 微调) |
| 自动跟踪 | 用内置快捷键/滚轮/菜单改的缩放也会自动记住(下次启动恢复) |
| 程序化接口 | 提供 `oc.zoom` IPC 契约(`get` / `set` / `zoomIn` / `zoomOut` / `reset` / `open`),供其他扩展调用 |

菜单和对话框文字为纯单语言,跟随 OpenCode 的界面语言设置(设置 → 外观 → 语言):中文界面显示中文,其他语言显示英文。

## 目录结构

```
opencode-zoom/
├── extension/            # 插件本体(安装的内容)
│   ├── manifest.json     # 扩展清单(opencode.gui-extension/1)
│   ├── main.js           # 主进程逻辑(记忆、菜单、对话框、IPC)
│   ├── renderer.js       # 占位(2.0.30 不加载第三方 renderer 入口)
│   └── style.css         # 占位
└── tools/
    ├── install.mjs       # 安装器(写入应用数据库)
    ├── uninstall.mjs     # 卸载器
    └── test-main.mjs     # 离线测试(模拟 Electron 跑 main.js)
```

## 环境要求

- Windows + OpenCode Desktop V2(打包版;数据目录 `%APPDATA%\ai.opencode.desktop`)
- Node.js ≥ 23(安装/卸载脚本使用内置 `node:sqlite`;插件本体不依赖 Node)

## 安装

1. **完全退出 OpenCode**(关闭所有窗口,托盘图标也退出);
2. 在本目录执行:

   ```powershell
   node tools\install.mjs
   ```

   脚本会先备份数据库(`drafts.sqlite.bak-oczoom-<时间戳>`),再写入扩展记录;
3. 重新打开 OpenCode。打开 View 菜单应该能看到新增的一项:

   - 缩放设置(英文界面下为 Set Zoom)

   如果没看到,请看下面的「故障排查」。

> 应用正在运行时脚本也可以执行(数据库有并发保护),但扩展要等完全重启后才会加载。
> 想先检查而不写入:`node tools\install.mjs --dry-run`。

## 使用

- **缩放设置**:输入缩放百分比(如 `87.5` 或 `125`),或点快捷预设;`−`/`+` 按钮按
  当前选择的**步进**微调(步进可选 1% / 2% / 5% / 10% 或手改配置文件)。`Enter` 应用、
  `Esc` 取消。应用后**所有窗口**生效,"比例"和"步进"都会保存。
- **内置缩放项**(View 菜单的 实际大小 / 放大 / 缩小,快捷键 Ctrl+= / Ctrl+- / Ctrl+0、
  Ctrl+滚轮)照常可用;改变后只要保持约 1 秒,新比例会自动成为"记忆值"。
- 多窗口:记忆值是全局的一个数;新窗口用它打开。窗口之间可以用内置控件各自微调,
  最后一次稳定的改变决定下次启动的比例。

## 配置文件

`%APPDATA%\ai.opencode.desktop\oc-zoom.json`(首次运行自动生成,可直接编辑,重启应用生效):

```json
{
  "zoom": 1.1,                  // 记忆的缩放比例(1 = 100%)
  "step": 0.05,                 // 步进(0.05 = 5%,0.01 = 1%,0.02 = 2%)
  "min": 0.25,                  // 允许的最小比例
  "max": 5,                     // 允许的最大比例
  "presets": [0.75, 0.9, 1, 1.1, 1.25, 1.5, 2]   // 对话框里的快捷预设
}
```

## 工作原理(简述)

- 插件是 OpenCode 桌面版的 **GUI 扩展**:`main.js` 在主进程内拿到 `BrowserWindow`,
  启动时读取记忆值并 `webContents.setZoomFactor()`,监听 `browser-window-created`
  让新窗口自动套用,并每秒轮询对比每个窗口的实际比例,把"外部"(内置控件)的改动
  在稳定 900ms 后写入配置。
- 打包版在应用内**禁用了扩展管理接口**(`ExtensionInstall` 等会抛 `unavailable`),
  因此安装器采用与官方安装流程相同的数据写入方式:直接写 `drafts.sqlite` 的
  `extension` / `extension_file` 表。应用启动时会无条件加载这两个表里的所有扩展。

## 验证

扩展的日志会写入 `%APPDATA%\ai.opencode.desktop\logs\` 下的日志文件(main.log 等),
搜索 `oc.zoom` 可看到:

- `[oc.zoom] activated {...}` —— 扩展已加载(附带版本、语言、记忆值)
- `[oc.zoom] zoom remembered {...}` —— 某次缩放被写入记忆
- `[oc.zoom] view menu items registered` —— 菜单项注册成功

## 卸载

```powershell
node tools\uninstall.mjs            # 移除扩展(配置保留)
node tools\uninstall.mjs --purge    # 连配置文件一起删
```

完全退出并重新打开 OpenCode 后恢复原生行为。安装时生成的 `*.bak-oczoom-*` 备份文件
确认无问题后可自行删除。

## 已知限制与风险

- 这是应用**未公开**的扩展机制,版本升级后如果存储结构或加载协议变化,扩展可能失效。
  失效时的表现:View 菜单没有新条目(看日志确认)。处理:升级本插件或先运行卸载器。
- 通过本插件在**运行中途**改动比例(对话框)后,应用页面内部还缓存着旧的比例值:
  紧接着用内置快捷键(Ctrl+= 等)可能从缓存值起算而偏差一步。点一次标题栏 View 菜单里的内置
  缩放项(或重启应用)即可恢复同步;之后一切正常。(启动恢复记忆值不受此影响。)
- Ctrl+滚轮是否缩放取决于应用的"捏合缩放"设置;未开启时 Ctrl+滚轮会把比例重置为 100%,
  这是应用自身的行为,与本插件无关。
- 缩放生效范围受 Chromium 限制(0.25–5 之间最稳妥,配置文件里 min/max 可调)。
- `renderer.js` / `style.css` 是占位文件:当前版本不执行第三方 renderer 入口,
  插件的 UI 全部由主进程提供(菜单 + 独立对话框)。
