# oc.zoom

[English](./README.md) | 中文

OpenCode 桌面版(V2)的缩放插件。解决两个问题:缩放不记忆(每次启动都回到 100%)、比例不可控(内置固定 ±20%)。通过桌面端 GUI 扩展机制实现,不修改应用本体。

## 功能

- **记住缩放** —— 重启自动恢复上次比例并应用到新窗口;用内置快捷键 / 滚轮改的也会记住
- **缩放设置** —— View 菜单 →「缩放设置」:任意百分比、快捷预设,`−`/`+` 按所选**步进**(1% / 2% / 5% / 10%)微调
- **跟随界面语言** —— 菜单和对话框文字跟随应用的界面语言设置(设置 → 外观 → 语言)

## 安装

需要 Node.js ≥ 23。

1. 完全退出 OpenCode(含托盘图标);
2. 在 `opencode-zoom` 目录执行:

   ```powershell
   node tools\install.mjs
   ```

3. 重新打开 OpenCode,View 菜单出现「缩放设置」即安装成功。

只检查不写入:`node tools\install.mjs --dry-run`。

## 卸载

```powershell
node tools\uninstall.mjs          # 移除扩展(配置保留)
node tools\uninstall.mjs --purge  # 连配置文件一起删
```

## 配置

`%APPDATA%\ai.opencode.desktop\oc-zoom.json`(首次运行自动生成,可直接编辑):

```json
{
  "zoom": 1.1,     // 记住的比例(1 = 100%)
  "step": 0.05,    // 步进(0.02 = 2%)
  "min": 0.25,     // 最小比例
  "max": 5,        // 最大比例
  "presets": [0.75, 0.9, 1, 1.1, 1.25, 1.5, 2]
}
```

## 说明

- 原理:扩展的 `main` 脚本运行在 Electron 主进程,负责设置 / 记住缩放;打包版没有安装入口,所以用脚本直接写应用数据库(会自动备份、可卸载)
- 日志:`%APPDATA%\ai.opencode.desktop\logs\` 里搜 `oc.zoom` 可确认加载
- 这是应用未公开的机制,版本升级后可能失效——升级本插件,或先运行卸载器
- 已知小问题:用本插件改比例后,立刻按内置快捷键可能偏差一步;点一次内置缩放项即恢复

## 工具

| 脚本 | 用途 |
| --- | --- |
| `install.mjs` | 安装(`--dry-run` 预览) |
| `uninstall.mjs` | 卸载(`--purge` 连配置) |
| `verify.mjs` | 校验数据库中内容与代码一致 |
| `test-main.mjs` | 离线测试(模拟 Electron 跑 main.js) |
| `preview-dialog.mjs` | 导出对话框 HTML 预览 |
