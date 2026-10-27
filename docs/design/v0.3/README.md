# PotBridge v0.3 主题设计预览

这是一份可以操作的设计稿，使用示例媒体和连接状态。它不读取浏览器标签、不会连接本机组件，也不会启动 PotPlayer。正式扩展仍为 v0.2.0。

在项目根目录运行：

```powershell
node docs/design/v0.3/serve.mjs
```

然后打开 <http://127.0.0.1:4173/>。需要 HTTP 服务来加载 JavaScript 模块，不要直接双击 HTML。

## 可以体验

- 五个主题：月下礼仪 / 瓷白 / 深蓝时刻 / 云母 / 墨绿。
- 左侧切换主题，上方切换弹窗和设置页；标题区调色板按钮也能切换主题。
- 主题在此预览中自动保存，重新打开后保留。关闭本地存储仍可以使用。
- 六种示例状态，以及检查、发送、结束中转的模拟反馈。
- 设置页的主题卡片、网络方式和可选诊断展开。
- 原生单选框键盘选择、可见焦点、Escape 关闭主题菜单和减少动态效果。

独立页面入口：`screen.html?theme=luna&view=popup&state=ready`。

支持的 `theme`：`luna`、`porcelain`、`reload`、`mica`、`forest`。

支持的 `view`：`popup`、`settings`。

支持的 `state`：`ready`、`empty`、`offline`、`missing`、`error`、`disabled`。

## 图像与参考

- `assets/luna-portrait.png`：内置 imagegen 生成的露娜同人立绘原图，具有真实 Alpha 透明通道。
- `assets/luna-portrait.webp`：同一图像的 WebP 编码版本，供设计预览使用；没有修改角色造型。
- `assets/luna-prompt.md`：生成提示词与身份参考来源。
- 角色辨识参考：[Navel 官方角色页](https://project-navel.com/tsukiniyorisou/chara01_luna.html)。角色与原作品归原权利人；本预览没有打包官方页面原图。
- 瓷白参考 [Apple Materials](https://developer.apple.com/design/human-interface-guidelines/materials)。
- 云母参考 [Fluent 2 Material](https://fluent2.microsoft.design/material)。浏览器页面模拟材质，不是真正的 Windows 桌面背景采样。
- 深蓝时刻参考 [P3R 官网](https://p3re.jp/)。使用原创几何装饰，没有复制游戏标识或 UI 截图。

设计规范见 [v0.3-design.md](../../v0.3-design.md)。
