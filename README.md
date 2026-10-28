# PotBridge · 映桥

**把网页里的视频，交给 PotPlayer。**

PotBridge 是面向 Windows 与 Microsoft Edge 的个人媒体桥接扩展。它发现当前网页的视频或直播地址，通过本机组件保留媒体请求所需的上下文，再将本地中转地址交给 PotPlayer 播放。

## 功能

- 发现页面中的 MP4、HLS、DASH 和 HTTP-FLV，结合网络请求、页面媒体元素与站点适配器整理候选源。
- Bilibili 普通视频：捕获初始播放信息、fetch 和 XHR 返回的音视频轨，按清晰度与编码区分；通过 PotPlayer 外部音轨同时播放画面和声音。
- Bilibili 直播：识别网页实际返回的 HTTP-HLS / HTTP-FLV 地址；保留原始签名和当前画质。
- 一键发送到 PotPlayer，支持媒体诊断、结束中转和脱敏诊断导出。
- 支持 HLS 子清单、独立音轨、AES-128 identity 密钥、初始化片段和 Range 请求。
- 提供站点开关；支持跟随 Windows 系统代理/PAC、直连或手动代理。
- cycani 适配器支持当前页面同一集的播放地址刷新。
- 560 × 600 px 弹窗，放大文字，播放按钮固定在底部。
- 分轨源显示 AVC/HEVC/AV1 与音频编码；缺少音轨时明确提示。无需新增 FFmpeg 运行依赖。

**v0.2.0** 已由用户确认 B 站普通视频的画面、声音和拖动，以及无刷新切换、HTTP-FLV 直播和代表性 DASH 播放正常。自动化结果与实际样本分别记录在 [验收记录](docs/acceptance.md)，不意味着兼容所有网站、编码和网络环境。

## v0.3 五款主题

**v0.3.0 已将五款主题接入正式扩展**，弹窗与设置页同步切换，默认使用露娜主题。点击弹窗右上角的调色板，或在设置页「外观与主题」选择；主题立即应用并自动保存。

| 主题 | 风格 |
| --- | --- |
| 月下礼仪 | 樱小路露娜立绘、象牙白、银灰与酒红 |
| 瓷白 | Apple 灵感，简洁浅色与蓝色操作 |
| 深蓝时刻 | P3R 灵感，电光蓝、切角与几何装饰 |
| 云母 | Fluent / WinUI 灵感，柔和灰紫与局部亚克力效果 |
| 墨绿 | 深色、低饱和绿，适合夜间观看 |

五主题共用操作布局。换肤保留未保存的播放器/代理设置和媒体选择，连接配置仍通过「保存设置」提交。主题偏好仅保存在本机，不上传或增加浏览器权限。字体、立绘和脚本均随包提供，没有 CDN 依赖。露娜为生成的同人立绘，人物来源见 [素材说明](docs/credits.md)。云母模拟网页材质，不采样 Windows 桌面壁纸。

[设计规范](docs/v0.3-design.md) 与 [独立设计预览](docs/design/v0.3/README.md) 保留供开发参考；正式安装请使用发行包中的 `extension` 目录。

## 下载

安装包见 [v0.3.0 Release](https://github.com/BackMay-HUI/PotBridge/releases/tag/v0.3.0)：`PotBridge-0.3.0-windows-x64.zip`；只有源码时，请按下文先构建、打包。可用同名 `.zip.sha256` 核对下载文件：

```powershell
Get-FileHash .\PotBridge-0.3.0-windows-x64.zip -Algorithm SHA256
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

扩展 ID 与安装位置有关。移动 `extension` 文件夹、重新安装或更换配置文件后，若 ID 变化，请用新 ID 重跑安装脚本。更新时先结束中转、关闭播放器，再替换插件文件并在 Edge 扩展页面点击重新加载；随后重跑本机安装脚本，并刷新已打开的视频页面一次以载入新版捕获脚本。

**从 v0.2 升级：主题功能只需更新扩展。** 将新版 `extension` 内容复制到原先加载的固定目录，在 Edge 重新加载扩展，再刷新已打开的视频网页一次。协议仍为 2，已安装的 v0.2 本机组件可以继续使用，不必为换肤重新安装。保持目录不变可保留扩展 ID、播放器路径和站点开关。若改为加载新目录导致 ID 改变，需用新 ID 重新绑定本机组件。

**从 v0.1 升级：扩展与本机组件必须一起更新。** v0.3 使用协议 2，连接 v0.1 组件时会提示 `VERSION_MISMATCH`。本机安装脚本会保留播放器、代理和 ffprobe 设置。

## 使用

- 全新安装默认启用 cycani、Bilibili 视频和直播。升级会保留原有站点开关；B 站若仍关闭，请先启用“此站点”，刷新页面并播放。
- B 站先在网页正常播放，再从扩展选择清晰度/编码。默认优先 AVC + AAC；只有网页实际返回的画质和音轨会显示。播放器兼容性取决于已安装版本和编码支持。
- 选择媒体源，再点击“用 PotPlayer 播放”。“重新检测”扫描页面；“诊断媒体”检查清单与资源；“更新地址”仅支持当前 cycani 页面中已捕获的同一集。
- “已发送”只说明播放器启动命令已提交。“播放器已请求媒体”说明本地中转收到请求；这两种状态都不能保证解码成功。
- 关闭插件弹窗、切换或关闭来源标签页后，已建立的中转仍工作；尚未完成的发送会随来源页面变化而取消。关闭 Edge、退出本机组件、点击“结束中转”会终止该中转；停止也会取消正在进行的播放预检。无人请求 30 分钟的会话自动回收，最多同时保留 4 个会话。
- 网络方式默认跟随 Windows 当前用户的系统代理（含 PAC）。可切换直连或填写 HTTP/HTTPS 代理 URL；不支持在 URL 中携带用户名密码，不自动尝试其他网络方式。407 表示代理需要认证。

## 支持边界

已实现 MP4、常规 HLS 点播/直播、HLS 子清单、AES-128 identity 密钥、独立音轨、初始化片段、Range 请求及直播清单更新。预检只抽查代表性资源；后续分片仍可能出现网络或授权问题。HLS 清单上限 2 MiB，每份清单最多 8192 个不同资源地址，本机会话最多保留 8192 个子资源映射（另加根地址），嵌套深度有限。超限时明确报错。

DASH 支持常见 MPD 的 BaseURL、SegmentBase、SegmentList、SegmentTemplate 与 SegmentTimeline，通过本地清单和资源中转保留 Range、签名查询和动态更新语义。特殊扩展、同层多 BaseURL 等暂不支持结构会明确报错。

HTTP-FLV 读取短前缀完成预检，不会为了检测而下载整场直播。B 站分轨分别预检，支持网站返回的备用地址；如果只有视频轨而没有音轨，会提示回网页播放后重新检测。旧式多段 durl 会明确显示“分段”，每段独立打开。

低延迟 HLS、SAMPLE-AES/DRM、WebRTC、WebSocket-FLV 和不支持的协议会明确区分。不会破解 DRM、绕过网站登录、付费或授权限制。能识别地址也不代表 PotPlayer 支持其编码。可在设置中指定自己安装的 `ffprobe.exe` 辅助查看编码；未内置 FFmpeg。

## 隐私和权限

插件申请 HTTP/HTTPS 页面访问、webRequest、脚本注入、存储与本机通信权限，用于跨站媒体发现和播放器启动。仅在启用的站点采集候选媒体；通用脚本会加载到普通 HTTP/HTTPS 页面以处理启用操作。没有遥测和云服务。

网页账户 Bearer 仅保留在该网页的适配器闭包中，用于同一页面、同一集的一次地址刷新，不传给本机组件。媒体 URL 的签名以及媒体请求所需 Cookie、Referer、Origin、User-Agent 会暂存在内存并传给本机组件；Cookie 按媒体来源域限定，不跨源转发。关闭浏览器或组件后不会保留这些内容。

中转仅监听随机的 `127.0.0.1` 端口，并要求随机会话令牌。导出的诊断不包含签名地址、Cookie、Bearer、会话令牌或页面标题，但包含媒体来源域、错误类别、请求数与时间。分享前仍建议查看内容。

## 排查与卸载

- **未连接本机组件**：确认扩展 ID 正确、安装脚本运行成功；企业管理策略也可能禁止本机通信。
- **VERSION_MISMATCH**：同时更新扩展和本机组件，重新加载扩展，再重新检查连接。
- **B 站未发现媒体**：先检查站点开关，刷新视频页并开始播放。新启用站点的旧页面必须刷新，才能加载播放信息捕获脚本。
- **B 站缺少音轨**：网页尚未返回完整播放信息，或当前内容使用其他传输/权限形式。请在网页正常播放后重新检测；不要把单独 m4s 分片当完整视频。
- **未检测到媒体**：刷新网页并先播放，检查站点开关；登录/获取地址失败时先让网页自身能播放。
- **401/403**：地址或资源授权失败。回网页重新播放，重新检测后发送。cycani 支持一次同集刷新，更新后可能需要重新发送。
- **567**：媒体 CDN 拒绝了请求。v0.2 已补上部分 B 站点播 CDN 要求的请求范围；如果仍失败，请刷新网页后重试，并导出脱敏诊断以定位具体轨道和媒体来源。
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
