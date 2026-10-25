# v0.1.0 发布检查

日期：2026-10-25。环境：Windows x64、Node 24、Go 1.27.3。

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 通过：TypeScript 检查、扩展生产产物和 Windows 本机 EXE |
| `npm test` | 29 / 29 通过，包含实际 Windows EXE 的协议测试 |
| `go test -race -count=1 ./...`（native 目录） | host、media、platform、protocol 全部通过 |
| 60 秒 `TestLiveRelayEndurance`（带 `-race`） | 通过：29 次窗口推进、171 次分片获取、4 次故障响应、2 次恢复；停止后返回 410 |
| `npm audit --omit=optional` | 0 个已知漏洞；不代表不存在未知漏洞 |
| 安装与卸载脚本语法检查 | 通过 |
| 中文及空格路径 `-PrepareOnly` 安装 | 通过：生成 EXE/清单，未改注册表 |
| `npm run package` / `npm run verify:package` | 生成版本化 ZIP，校验入口、资源、EXE 及 SHA256 |
| 发布前独立代码复审 | 两项 P2 均经失败回归测试复现后修复，复审无剩余发布阻碍 |

直播测试使用合成数据，验证中转行为，不证明实际画面和声音；真实 Edge/PotPlayer 成功播放为用户反馈，详见 [验收记录](acceptance.md)。未完成的长时间真实平台测试仍按该记录保留，不宣称“兼容所有网站”或“全部场景完善”。

测试运行期间 Node 对测试工具使用的 `stripTypeScriptTypes` 给出实验特性提示；29 项测试全部执行通过。
