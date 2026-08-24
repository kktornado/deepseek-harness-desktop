# Third-Party Notices

本项目（DeepSeek Harness Desktop）的安装包会捆绑并重新分发以下第三方软件与代码。
本文件列出各组件及其许可证；完整许可证文本由构建流程通过 `license-checker` 自动收集并随包分发。

## 项目本体

- **DeepSeek Harness Desktop** — MIT License
  Copyright (c) 2026 deepseek-harness-desktop contributors
  壳程序（Electron 主进程、加载页、控制台、桌面插件），独立编写，MIT 授权。

## 捆绑分发的第三方组件

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| Node.js（官方便携版二进制） | harness 运行时（Node 22+，`node:sqlite`） | Node.js License（含附加归属条款，重新分发二进制必须附带其 LICENSE 全文） |
| pnpm | harness 插件管理（`dsh plugin` 转调） | MIT |
| Electron | 桌面壳运行时 | MIT |
| electron-updater | 壳自动更新 | MIT |
| electron-builder | 打包（构建期依赖） | MIT |
| `@deepseek-ai/dsh` 及全部 npm 依赖 | harness 引擎（web profile），首次启动联网安装到用户数据目录（不随安装包分发） | MIT |
| 桌面壳插件及依赖 | 服务直连 / profile / 桌面 contract | MIT |

## 商标

"DeepSeek" 与 "DeepSeek Harness" 是深度求索公司的注册商标。本项目为独立社区项目，
与深度求索不存在隶属、合作、授权或背书关系；仅在准确说明技术来源与兼容性时使用上述名称。

## 许可证文本来源

构建流程在打包前运行 `license-checker`（或等价工具），将上述组件的完整许可证文本收集至
`dist/THIRD_PARTY_NOTICES/` 目录，随安装包一并分发。本文件为清单与声明，完整文本以构建产物为准。