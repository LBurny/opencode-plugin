# OpenCode 插件集

本仓库是 OpenCode 插件集合:**一个插件一个文件夹**,每个插件独立安装、独立说明。

| 插件 | 说明 |
| --- | --- |
| [opencode-zoom](./opencode-zoom) | 桌面端(OpenCode Desktop V2)缩放:记忆比例跨重启恢复、任意百分比设置、可配置步进(1%/2%/5%/10%) |

## 目录约定

```
.
├── README.md            ← 本索引
├── opencode-zoom/       ← 插件:桌面端缩放
│   ├── README.md        ← 安装与使用说明
│   ├── extension/       ← 插件本体
│   └── tools/           ← 安装 / 卸载 / 校验 / 测试脚本
└── opencode-xxx/        ← 后续插件……
```

## 新增一个插件

1. 在仓库根目录新建插件文件夹,例如 `opencode-myplugin/`;
2. 该文件夹内自带 `README.md`(安装与使用说明)以及插件本体、脚本等;
3. 在上面的表格里加一行链接;
4. 提交并推送:

   ```powershell
   git add .
   git commit -m "add opencode-myplugin"
   git push
   ```

## 更新已有插件

在对应插件文件夹内修改,然后 `git add .` → `git commit` → `git push`。
