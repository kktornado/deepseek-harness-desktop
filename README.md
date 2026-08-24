# DeepSeek Harness Desktop

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-4D6BFE?style=flat-square)](https://github.com/kktornado/deepseek-harness-desktop/releases)
[![Platform: Linux](https://img.shields.io/badge/platform-Linux-4D6BFE?style=flat-square)](https://github.com/kktornado/deepseek-harness-desktop/releases)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-4D6BFE?style=flat-square)](https://github.com/kktornado/deepseek-harness-desktop/releases)
[![dsh channel](https://img.shields.io/badge/dsh-follow%20npm%20channel-4D6BFE?style=flat-square)](https://www.npmjs.com/package/@deepseek-ai/dsh)

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 变成**零依赖、零配置**的桌面应用：

用户只需安装一个安装包，无需安装 Node.js / git / pnpm、无需 clone 源码、无需构建、无需打开终端。
内嵌窗口直接显示完整 Web UI，启动即用。

独立的社区项目，与深度求索不存在隶属、合作、授权或背书关系；"DeepSeek Harness" 是深度求索公司的注册商标，
此处仅为准确说明技术来源与兼容性而使用。

## 功能

- **零依赖**：捆绑官方 Node.js 便携版 + pnpm；引擎首次启动联网安装（无需系统环境，装好后离线可用）
- **引擎实时更新**：版本走 npm 通道（`latest` / `next` / 任意已发布版本），启动后台检查、界面浮层提醒"立即更新"
- **壳自动更新**：应用本体通过 GitHub Releases 更新（electron-updater），双层闭环、全程无感
- **插件壳**：桌面插件以官方 Cordis 插件机制挂进 harness——界面内可直接安装/管理上游插件
- **多配置（Profile）**：切换不同模型、插件、工作目录组合
- **托盘驻留**：关闭窗口驻留托盘，随时显示界面/进入控制台/退出
- **稳健**：日志落盘 + 一键复制诊断信息、服务崩溃自愈、渲染崩溃兜底、端口占用识别
- **局域网访问**（可选，默认关）：绑定局域网 IP + trusted-host 白名单，手机浏览器使用

## 下载与安装

| 平台 | 安装方式 |
| --- | --- |
| Windows x64 | 运行 NSIS 安装程序，或直接运行便携版 exe |
| Linux x64 | AppImage（需 FUSE）或 `.deb` 包（Debian/Ubuntu） |
| macOS (universal) | 打开 `.dmg` 拖入 Applications |

安装包由仓库内 GitHub Actions 在打 tag 时自动构建并发布到 [Releases](../../releases) 页面。
安装后双击即可使用，无需任何系统依赖。

## 快速开始

1. 安装并启动应用 → 加载页数秒后自动进入 Web 界面
2. 首次使用 agent：在界面"设置 → 模型"中添加模型与 API key（壳不处理密钥）
3. 有新版引擎：界面右下角浮层提醒 → 点击"立即更新"自动安装并刷新
4. 随时返回控制台：浮层按钮或 `Ctrl+Shift+D`（可改）；关闭窗口自动驻留托盘

## 构建与打包

```sh
npm install

npm run build:win        # Windows: NSIS 安装包 + 便携版
npm run build:linux      # Linux: AppImage + deb（推荐 CI）
npm run build:mac        # macOS: dmg + zip（只能在 macOS 构建）
```

打包流程会自动下载 Node 便携版与 pnpm，并连同桌面插件一并打包（引擎不打包，首次启动联网安装）。
Linux/macOS 包需在对应平台或 CI 上构建（Windows 交叉构建受系统限制，见 [CONTRIBUTING.md](CONTRIBUTING.md)）。

一键发布（GitHub Actions，打 tag 自动构建三平台并发布 Release）：

```sh
git tag v0.1.2
git push origin v0.1.2
```

## 镜像与网络（国内用户）

`npm install` 需要从 GitHub 下载 Electron 与打包工具二进制。仓库不提交 `.npmrc`，网络受限时在项目根目录
手动创建：

```ini
electron_mirror=https://npmmirror.com/mirrors/electron/
electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
```

## 已知限制

- 安装包约 108MB（捆绑 Node + pnpm + 桌面插件；引擎首次联网安装，不随包分发）
- 引擎更新/安装插件需要联网；离线时使用现有版本，不阻塞
- 未签名阶段有 SmartScreen / Gatekeeper 提示；正式分发需代码签名证书
- agent 功能需要 API key，在 harness 界面"设置 → 模型"中配置
- 局域网访问开启后 agent 可被局域网内白名单设备调用，仅建议可信网络使用
- Windows exe 图标由构建后的 rcedit 钩子写入 `build/icon.ico`（免签构建关闭 winCodeSign，故不走 electron-builder 内置资源编辑）
- 版本跟随上游发布节奏（rc 阶段更新频繁，符合"用最新"诉求）

## 目录结构

```
src/
  main.js        主进程：运行时解析、版本管理、服务生命周期、托盘、窗口
  preload.js     contextBridge 暴露 window.desktop API
  renderer/      加载页 / 控制台界面
  plugin/        桌面壳插件（Cordis 插件：服务直连、profile、桌面 contract）
build/
  icon.ico       Windows 安装包/快捷方式图标
  icon.png       512x512 图标（Linux/macOS 打包使用）
.github/workflows/  build.yml：三平台构建 + 打 tag 自动发布
docs/            用户指南 / FAQ / 架构说明
dist/            打包产物（electron-builder 输出，不入库）
```

## License

[MIT](LICENSE) · 第三方组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

> "DeepSeek Harness" 是深度求索公司的注册商标。本项目是独立社区项目，与深度求索不存在隶属、合作、授权或背书关系。
> 致谢上游 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 [Cordis](https://github.com/cordiverse) 项目。