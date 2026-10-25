# PotBridge · 映桥

**把网页里的视频，交给 PotPlayer。**

PotBridge 是面向 Windows 与 Microsoft Edge 的个人媒体桥接扩展。它发现当前网页的视频或直播地址，通过本机组件保留媒体请求所需的上下文，再将本地中转地址交给 PotPlayer 播放。

## 功能

- 发现页面中的 MP4、HLS 点播和直播，结合网络请求、页面媒体元素与站点适配器整理候选源。
- 一键发送到 PotPlayer，支持媒体诊断、结束中转和脱敏诊断导出。
- 支持 HLS 子清单、独立音轨、AES-128 identity 密钥、初始化片段和 Range 请求。
- 提供站点开关；支持跟随 Windows 系统代理/PAC、直连或手动代理。
- cycani 适配器支持当前页面同一集的播放地址刷新。
- 560 × 600 px 弹窗，放大文字，播放按钮固定在底部。

当前版本为 **v0.1.0**。用户已在真实 Edge + PotPlayer 环境确认本机连接和原始案例播放成功。自动化检查、实际用户反馈及未覆盖场景分别记录在 [验收记录](docs/acceptance.md)；这不意味着兼容所有网站、编码和网络环境。

## 下载

在 [Releases](https://github.com/BackMay-HUI/PotBridge/releases) 下载 `PotBridge-0.1.0-windows-x64.zip` 并完整解压。若只有源码，请按下文先构建、打包。可用同名 `.zip.sha256` 核对下载文件：

```powershell
Get-FileHash .\PotBridge-0.1.0-windows-x64.zip -Algorithm SHA256
```

## 安装

需要 Windows x64、Edge 120 或以上及已安装的 PotPlayer。本机组件无需 Go、Node 或管理员权限。扩展采用“加载解压缩的扩展”安装方式，尚未上架 Edge 扩展商店。

1. 将完整 ZIP 解压到固定位置，不要只解压可执行文件。
2. 在 Edge 打开 `edge://extensions`，开启“开发人员模式”，点击“加载解压缩的扩展”，选择解压目录内的 **extension** 文件夹。
3. 复制扩展卡片上的 32 位扩展 ID。也可打开插件设置点击“复制扩展 ID”。
4. 在解压目录打开 PowerShell，运行下面命令，把占位内容替换为刚复制的 ID：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-host.ps1 -ExtensionId "这里替换为实际的32位扩展ID"
   ```

   该命令的执行策略仅作用于此进程。脚本把组件复制到 `%LOCALAPPDATA%\PotBridge\native`，并在当前用户的 Edge NativeMessagingHosts 注册表项注册；不会安装服务或创建开机启动任务。
5. 打开插件设置，确认本机组件已连接。自动查找不到 PotPlayer 时，填写实际的 `PotPlayerMini64.exe`、`PotPlayerMini.exe` 或其他 PotPlayer 可执行文件的完整路径，然后保存。
6. **刷新视频网页**，正常登录并先在网页开始播放。安装前已打开的页面需要刷新才能注入捕获脚本。

请从 Windows 开始菜单自行打开 PowerShell 运行安装命令。某些打包应用启动的命令会把 AppData 写入重定向到应用私有目录，导致脚本自己能读到文件，但 Edge 报 `NATIVE_HOST_NOT_FOUND`。安装脚本现在会检查实际文件路径，发现重定向就停止注册。也可以在安装命令末尾添加 `-PlayerPath "D:\实际目录\PotPlayer.exe"` 同时保存播放器路径。

扩展 ID 与安装位置有关。移动 `extension` 文件夹、重新安装或更换配置文件后，若 ID 变化，请用新 ID 重跑安装脚本。更新时先结束中转、关闭播放器，再替换插件文件并在 Edge 扩展页面点击重新加载；随后重跑本机安装脚本。

## 使用

- `https://www.cycani.org` 默认启用。其他网站先打开插件、启用“此站点”，刷新页面并播放。
- 选择媒体源，再点击“用 PotPlayer 播放”。“重新检测”扫描页面；“诊断媒体”检查清单与资源；“更新地址”仅支持当前 cycani 页面中已捕获的同一集。
- “已发送”只说明播放器启动命令已提交。“播放器已请求媒体”说明本地中转收到请求；这两种状态都不能保证解码成功。
- 关闭插件弹窗后中转仍工作。关闭 Edge、退出本机组件、点击“结束中转”会终止该中转；无人请求 30 分钟的会话自动回收。最多同时保留 4 个会话。
- 网络方式默认跟随 Windows 当前用户的系统代理（含 PAC）。可切换直连或填写 HTTP/HTTPS 代理 URL；不支持在 URL 中携带用户名密码，不自动尝试其他网络方式。407 表示代理需要认证。

## 支持边界

已实现 MP4、常规 HLS 点播/直播、HLS 子清单、AES-128 identity 密钥、独立音轨、初始化片段、Range 请求及直播清单更新。预检只抽查代表性资源；后续分片仍可能出现网络或授权问题。HLS 清单上限 2 MiB，每份清单最多 8192 个不同资源地址，本机会话最多保留 8192 个子资源映射（另加根地址），嵌套深度有限。超限时明确报错。

DASH、低延迟 HLS、SAMPLE-AES/DRM 和不支持的协议会明确报错。不会破解 DRM、绕过网站登录、付费或授权限制。能识别地址也不代表 PotPlayer 支持其编码。可在设置中指定自己安装的 `ffprobe.exe` 辅助查看编码；未内置 FFmpeg。

## 隐私和权限

插件申请 HTTP/HTTPS 页面访问、webRequest、脚本注入、存储与本机通信权限，用于跨站媒体发现和播放器启动。仅在启用的站点采集候选媒体；通用脚本会加载到普通 HTTP/HTTPS 页面以处理启用操作。没有遥测和云服务。

网页账户 Bearer 仅保留在该网页的适配器闭包中，用于同一页面、同一集的一次地址刷新，不传给本机组件。媒体 URL 的签名以及媒体请求所需 Cookie、Referer、Origin、User-Agent 会暂存在内存并传给本机组件；Cookie 按媒体来源域限定，不跨源转发。关闭浏览器或组件后不会保留这些内容。

中转仅监听随机的 `127.0.0.1` 端口，并要求随机会话令牌。导出的诊断不包含签名地址、Cookie、Bearer、会话令牌或页面标题，但包含媒体来源域、错误类别、请求数与时间。分享前仍建议查看内容。

## 排查与卸载

- **未连接本机组件**：确认扩展 ID 正确、安装脚本运行成功；企业管理策略也可能禁止本机通信。
- **未检测到媒体**：刷新网页并先播放，检查站点开关；登录/获取地址失败时先让网页自身能播放。
- **401/403**：地址或资源授权失败。回网页重新播放，重新检测后发送。cycani 支持一次同集刷新，更新后可能需要重新发送。
- **PotPlayer 渲染错误**：使用“诊断媒体”，导出设置页的诊断，再记录 PotPlayer 的完整错误文字。HTTP 检查通过不等于解码通过。
- **找不到播放器**：检查设置中的完整路径和文件是否存在。路径字段不接受命令参数。
- **卸载**：结束中转并关闭 Edge，运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-host.ps1`，再在 Edge 移除扩展。脚本撤销当前用户注册并清理标准目录内的本组件文件与设置，不触碰 PotPlayer。需要保留设置时添加 `-KeepSettings`。自定义安装目录保留给用户手动清理；文件仍被占用时会打印未能删除的路径。

## 从源码构建与检查

需要 Node 24+、Go 1.27+、Windows x64。开发环境可使用项目 `.tools/go/bin/go.exe`，否则使用 PATH 中的 `go`。

```powershell
npm ci
npm run build
npm test
cd native
go test -race -count=1 ./...
cd ..
npm run package
npm run verify:package
```

`npm run build` 先做 TypeScript 检查，再生成 `dist/extension` 和 `native/bin/potbridge.exe`。`npm test` 包含真实本机可执行文件的协议测试，需先构建。`npm run package` 将当前构建复制到版本化 `release` 目录并生成 ZIP、逐文件校验和与 ZIP 校验和。安装包没有数字签名，Windows 可能提示未知发布者。

直播中转另有可选的传输持续性测试，检查移动窗口、上游故障恢复、资源上限及停止后的清理。它使用合成数据，不验证视频解码：

```powershell
$env:POTBRIDGE_LIVE_SOAK_SECONDS = '60' # 可设为 900，执行 15 分钟检查
go -C native test -race -count=1 -run '^TestLiveRelayEndurance$' -v ./internal/media
Remove-Item Env:POTBRIDGE_LIVE_SOAK_SECONDS
```

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `extension/` | Manifest V3 扩展、媒体捕获、弹窗和设置页 |
| `native/` | Go 本机通信组件、媒体预检、本地中转和播放器启动 |
| `scripts/` | 构建、打包、校验、当前用户安装与卸载 |
| `tests/` | 扩展逻辑、页面隔离、UI 安全和真实 EXE 协议测试 |
| `docs/` | 协议、验收与代码审查记录 |

问题反馈请写明 Windows/Edge/PotPlayer 版本、媒体格式、复现步骤与完整错误文字。不要上传带签名的媒体链接、Cookie、Bearer 或未经检查的浏览记录；优先使用设置页导出的脱敏诊断。

PotBridge 与 Microsoft Edge、PotPlayer 及相关网站没有隶属关系。仓库暂未授予开源许可；第三方依赖遵循各自许可证。
