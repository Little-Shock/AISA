# 0006 Fail-Closed Artifact Reads

## 背景

AISA 的运行面大量依赖文件工件。

- `state-store` 负责 run、attempt、project、report、plan、context 等状态读取
- `event-log` 负责 goal 事件流
- `orchestrator` 负责 package/toolchain 探测与执行前 readiness 判断

之前这几层里有一批读取逻辑把所有异常都当成缺文件处理。

- 坏 JSON 会被当成 `null`
- 坏 NDJSON 会被当成空数组
- 不可读目录会被当成目录不存在
- 损坏的 `package.json` 会被当成没有 `package.json`

这会把真实坏状态伪装成正常空值，让控制面继续往下跑。

## 决策

从这一版开始，artifact 读取统一按 fail-closed 处理。

- 只有 `ENOENT` 代表工件确实缺失，才允许映射成 `null`、空数组或空字符串
- JSON/NDJSON 解析失败必须原样抛出
- schema 校验失败必须原样抛出
- 权限错误、目录结构错误、符号链接异常这类文件系统错误必须原样抛出

目录枚举也按同一条规则执行。

- 允许跳过真正未写完的目录，也就是目标文件缺失的目录
- 不允许跳过已经存在但内容损坏的目录

`state-store` 的 `plan artifacts` 额外收紧成顺序读取，避免某个文件缺失时把同目录里另一个已损坏文件一起吞掉。

## 验证

新增 `pnpm verify:fail-closed-artifacts`。

这套验收脚本会主动制造这些坏路径。

- 损坏 JSON
- 损坏 NDJSON
- 不可读目录
- 缺失文件
- 半写入目录

验收标准只有一条。

- 真缺失还能按可选工件读取
- 真损坏不能被伪装成缺失

## 影响

控制面现在更早暴露状态损坏和文件系统问题。

这会让部分旧的“静默降级”路径改成直接失败，但这是预期行为。运行时如果现场已经坏掉，AISA 应该先暴露坏状态，而不是带着假正常继续推进。
