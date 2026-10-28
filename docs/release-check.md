# v0.3.0 发布检查

日期：2026-10-28。环境：Windows x64、Node 24、现有本地 Go 工具链。每项记录仅覆盖所列范围。

| 检查 | 结果 |
| --- | --- |
| TypeScript / 生产构建 | 通过；正式 popup/options、共享主题模块、后台及注入脚本、Windows EXE 均生成 |
| `npm test` | 87 / 87 通过，包含生产 HTML/控制器与实际 EXE 协议测试 |
| 主题回归 | 迟到读取、重叠写入、跨页同步/删除、坏数据、读写失败、菜单 Escape、配置/媒体选择/焦点保留均通过 |
| 原操作回归 | 生产控制器的发送、停止、保存、导出、离线提示通过；主题选择不触发本机 RPC |
| `go test -race -count=1 ./...` | host、media、platform、protocol 全部通过 |
| `go vet ./...` | 通过 |
| 安装脚本语法及 `-PrepareOnly` | 通过；中文与空格路径、扩展 origin、EXE 哈希正确，没有改动注册表 |
| `npm run package` / `npm run verify:package` | 通过；25 个文件、全部逐文件 SHA256、入口、HTML/CSS 本地资源、早期主题脚本、WebP 和 ZIP 校验一致 |
| 素材预算 | WebP 318,606 字节；小于 400 KB，随包提供，无远程请求 |
| 权限和协议 | 未新增权限或运行时依赖；Native Messaging 仍为协议 2，兼容 v0.2 本机组件 |

独立审查结果见 [v0.3 审查记录](review-v03.md)。公开仓库的发行步骤在所有代码审查与包检查完成后执行；发布工具逐项核对主分支/标签提交、release 非草稿、ZIP/校验文件远端大小与 SHA256，并保留 v0.1/v0.2 的既有发行包。

浏览器验证限制：Computer Use 因无法可靠识别当前 Windows 浏览器 URL 而中止，本轮未完成正式界面的视觉/Edge 内操作与 PotPlayer 解码复测。测试中的 Chrome 和本机边界是受控替身，不能代替真实浏览器或播放器解码。设计预览的旧截图与 v0.2 用户播放确认保留为各自历史证据，详见 [验收记录](acceptance.md)。

Node 测试工具使用 `stripTypeScriptTypes`，会显示实验特性提示；没有将该提示隐藏或计为失败。安装包尚无数字签名，扩展未上架 Edge 商店。
