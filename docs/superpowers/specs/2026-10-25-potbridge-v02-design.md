# PotBridge v0.2 更广媒体覆盖设计

## 用户目标与决定

v0.1 的单 URL 模型无法覆盖 Bilibili 等网站的音视频分离播放。v0.2 必须扩大实际可播放范围，重点让 B 站普通投稿视频在 PotPlayer 同时有画面和声音，并保留 v0.1 的 MP4/HLS 能力。

用户授权自行挑选公开 B 站视频验收；未指定其他网站。用户选定轻量实现，明确后续细节由实现者决定、无需逐项确认。

## 方案

采用现有 TypeScript + Go + PotPlayer，不新增 FFmpeg 运行依赖。B 站分轨通过两条本地中转地址和 PotPlayer `/aud` 一起打开；该参数已从本机 PotPlayer 随附的 CmdLine64.txt 核对。DASH MPD 通过本机清单/资源代理交给播放器；HTTP-FLV 直接流式中转。

考虑但不采用强制 FFmpeg 合流：格式处理更灵活，但增加安装体积、进程生命周期和拖动实现复杂度。选择轻量方案不意味着可以把单独视频轨误报为完整音视频。

## 范围与验收

1. Bilibili 普通视频：初始播放信息、fetch 和 XHR 播放响应均可发现；提取视频/音频轨、清晰度、编码及备用地址。候选按清晰度/编码区分，默认优先可兼容的 AVC + AAC。分 P/SPA 导航后不误用上一视频的轨道。
2. Bilibili 直播：从页面真实播放响应发现 HTTP-HLS/HTTP-FLV；尊重站点启用开关。适配器只使用网站已返回的授权内容，不自行生成签名或绕过权限。
3. 通用媒体：保留 MP4/HLS，新增 HTTP-FLV、DASH MPD（常见 BaseURL、SegmentBase、SegmentList、SegmentTemplate、SegmentTimeline；清单刷新保留动态语义）。不把孤立的 m4s 片段当完整视频。
4. 分轨中转：视频/音频各自预检、Range 请求、准确来源头隔离、统一停止/过期/取消；播放器进程参数使用独立 argv，原始签名 URL 不放到播放器命令行。
5. DASH 中转：解析并重写资源引用，所有上游请求继续经过现有私网/DNS/重定向校验。不暴露未认证本地代理，禁止任意远程主机注入。DRM/外部 XML 引用及不支持结构明确报错。
6. UI：560×600 弹窗中显示清晰度、编码和音视频状态；区别分轨、清单及直播。新旧本机组件不匹配时明确要求升级。
7. 回归：v0.1 全部自动化测试必须保持通过；新增真实格式边界测试。至少挑选公开 B 站普通投稿，确认捕获、发送、PotPlayer 画面/声音和拖动；实际直播及代表性 DASH 样本检验。测试或 HTTP 200 不能替代真实解码验收。
8. 版本化：扩展、host、包及文档更新为 0.2.0，生成独立发布包和 SHA256，保留 v0.1 发布产物。

## 数据与信任边界

MediaCandidate 保留 url 作为主地址，增加可选 video/audio 轨、quality、contentId、live。MediaTrack 包含 url、backupUrls、id、mimeType、codecs、bandwidth、width/height/frameRate 等有界元数据。source 增加 bilibili，format 增加 flv，dash 可表示 MPD 或具有 video/audio 的分轨源。

网页提供的数据全部验证并有界化。页面来源不能启动播放器、修改可执行路径或自行指定可信请求头。B 站适配器仅在顶层可信站点生效；contentId 与页面代次一起隔离。捕获的媒体头仅应用到准确来源和 frame；B 站 Referer 默认值由扩展控制器构造。不主动读取浏览器账户 Cookie 库或采集账户 Authorization；API 请求头不传给本机，已有媒体请求的必要 Cookie 仍按来源限定。

Native Messaging 升到协议 2，避免 v0.1 host 忽略新轨字段后默默播放无声视频。旧版本应收到 VERSION_MISMATCH。外部 /aud 只接受本次会话生成的 loopback 音频 URL。

## 实现分层

- 独立 B 站响应解析器与 MAIN 适配器；保留 cycani 适配器。通用内容脚本只转发经验证的结构化候选。
- 扩展控制器负责信任、页面隔离、候选优先级、准确媒体请求头与 UI 状态。
- Go media 层负责复合候选预检、双轨资源、FLV 短前缀识别、MPD 重写及流式代理。
- platform 层负责 `/aud` argv 与现有启动、代理和 ffprobe 可选功能。

## 限制

不破解 DRM，不绕过登录/付费限制，不保证所有网站或编码。WebRTC、WebSocket-FLV 等非 HTTP 传输明确区分。浏览器工具当前禁止访问扩展内部页面；若实际安装/重新加载需要用户操作，在构建和包验证完成后给出准确步骤，未得到实测证据前不宣称验收完成。

## 参考依据

- 本机 PotPlayer CmdLine64.txt：/aud、/same、HTTP 相关参数。
- https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/bilibili.py ：作为播放数据形状的主要源码参考，不引入该工具作为运行依赖。
- https://github.com/bilibili/flv.js ：B 站 FLV/MSE 播放实现说明。
- https://ffmpeg.org/ffmpeg-formats.html ：DASH 容器与清单语义参考。
