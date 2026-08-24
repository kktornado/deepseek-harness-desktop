# Contributing

欢迎参与 DeepSeek Harness Desktop 的开发。在提交 PR 前请阅读本指南。

## 项目简介

DeepSeek Harness Desktop 是 DeepSeek Harness 的零依赖桌面包装程序：

- 捆绑官方 Node.js 便携版 + pnpm；引擎首次启动联网安装（无需任何系统依赖）
- 壳以 Cordis 插件机制挂进 harness 子进程（服务直连、profile 切换、桌面能力 contract）
- 引擎（dsh）走 npm 通道更新，壳本体走 GitHub Releases（electron-updater）

完整方案见 [SOLUTION.md](SOLUTION.md)。

## 开发环境

- Node.js ≥ 22.19（或使用仓库内说明的版本），pnpm 可选（仅插件管理测试需要）
- Windows / Linux / macOS 均可开发；Linux/macOS 打包仅能在对应系统或 CI 上进行

## 构建与测试

```sh
npm install          # 安装开发依赖（electron、electron-builder 等）
npm run build:win    # Windows NSIS + 便携版
npm run build:linux  # Linux AppImage + deb（推荐在 CI 构建）
npm run build:mac    # macOS dmg + zip（只能在 macOS 构建）
```

提交前请确保：

1. 改动通过 `node --check` 语法检查（涉及主进程/preload 时）
2. 涉及行为变更时更新 [SOLUTION.md](SOLUTION.md) 与 README
3. 不提交构建产物（`dist/`）与本地镜像配置（`.npmrc`）

## 提交 PR

- 一个 PR 只做一件事；拆分无关改动
- 提交信息简洁描述改动与原因
- 变更核心里程碑/用户可见行为时，附上说明与（如可行）截图
- 保持与主分支同步，PR 可合并后再 rebase

## 代码规范

- 无硬编码可调参数：部署相关选择放在 `Config` 中，可由用户配置
- 日志：控制台日志落盘 `userData/logs/`，关键路径记录诊断信息
- 错误处理：进程异常要能自愈或给出明确指引，避免静默失败

## 安全问题

发现安全问题（如远程访问、密钥处理、更新链路漏洞）请**不要**通过公开 issue 报告，
改走 [SECURITY.md](SECURITY.md) 中的私密渠道。