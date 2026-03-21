# Domain

职责：

- 定义 `Goal`、`Branch`、`WorkerRun`、`Steer`、`Event` 等核心对象
- 提供运行时 schema 校验
- 统一状态枚举和基础 ID 生成

输入：

- API 请求体
- 文件系统中的 JSON 状态对象

输出：

- 经过校验的领域对象
- 可被其他模块复用的 TypeScript 类型
