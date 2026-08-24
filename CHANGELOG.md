# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格。
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)；每个发布版对应一个 git tag（`v*`）。

## [Unreleased]

## [0.1.2] - 2026-08-24

### 变更（引擎不再随包捆绑）

- 引擎改为**首次启动联网安装**（捆绑 pnpm + `--node-linker=hoisted` 平铺安装），不再随安装包捆绑 `@deepseek-ai/dsh` 依赖树
- 安装包从 ~153MB 降至 ~108MB；portable 每次解压从数万文件恢复为秒开
- 新增已装引擎**完整性校验**（`verifyInstalled`）：残缺树启动时自动删除并回退，避免崩溃循环
- 新增**新图标**（`build/icon.ico` 六尺寸，源图 `dist/ico.png`）；Windows exe 图标由 afterPack 的 rcedit 钩子写入
- 新增 `scripts/make-icons.mjs` 图标生成脚本；`rcedit`/`sharp`/`png-to-ico`/`esbuild` 加入开发依赖
- 修复：copyPlugin 悬挂 junction 导致的 EEXIST

### 已实现（自 0.1.0 规划）

- 零依赖：捆绑官方 Node.js 便携版 + pnpm，用户无需安装任何系统依赖
- 混合式插件壳：桌面插件以 Cordis 插件机制挂进 harness 子进程（服务直连 / profile 切换 / 桌面能力 contract）
- 引擎版本管理：npm 通道（latest / next / 指定版本），启动后台检查、界面浮层提醒更新
- 托盘驻留、局域网访问（默认关）、日志落盘 + 诊断复制、服务崩溃自愈、端口占用识别
- 壳自动更新（electron-updater，GitHub Releases 渠道）

## [0.1.0] - 未发布

### 已开发（旧 git 方案，将按新方案替换）

- 启动时自动 `git fetch` / `git pull --ff-only` / `pnpm install` / `pnpm run build`
- 自动启动 `dsh web`（默认端口 3080，占用复用）、内嵌窗口显示 Web UI
- `Ctrl+Shift+D` 返回控制台；三平台打包（Windows NSIS/便携版、Linux AppImage/deb、macOS dmg/zip）
- GitHub Actions 打 tag 自动发布 Release