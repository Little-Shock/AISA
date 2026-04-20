# AISA 项目隔离运行时需求

## 状态

草案。基于 2026-04-20 OpenShock 接入 AISA 时暴露的问题整理。

## 背景

AISA 已经有外部项目开发需要的几个对象：attached project、run、attempt、managed worktree。方向是对的，但当前实现还没有把 AISA runtime 的身份和被开发项目的身份彻底拆开。

现在的 workspace scope 主要从 AISA runtime repo root 和 AISA dev repo root 推导。这个设计会让外部项目接入变脆。OpenShock 验证时，为了让 `/Users/atou/OpenShockSwarm` 通过 workspace gate，曾经临时把 `AISA_DEV_REPO_ROOT` 指向 OpenShock。这样能跑，但概念上是错的。OpenShock 不是 AISA 的 dev repo。OpenShock 是 AISA runtime 管理的外部 project。

这次还暴露了另一个问题。本机已有 8787 端口上的 AISA 长期实例在使用 `/Users/atou/.aisa-runtime`。临时给 OpenShock 起的 AISA 一开始也用了这个 runtime data root。结果 8787 那个实例扫到了 OpenShock run，并按自己的 allowed roots 判断，把 OpenShock 标成越界。也就是说，只要多个 AISA runtime 实例共享同一个 runtime data root，而且 scope policy 不一致，它们就可能互相污染 run 状态。

这不符合 AISA 作为多项目开发 runtime 的定位。

## 目标模型

AISA 必须把自己当成 runtime，而不是把自己当成正在被开发的项目。

AISA runtime repo 是控制面的可执行代码。runtime data root 是一个 runtime 实例的运行状态目录。project workspace 是 AISA 被授权管理的外部 repo 或目录。run 必须属于一个明确的 project。execution attempt 只能写入该 run 的 managed worktree，不能直接写源项目，除非后续有明确的 promote 或 apply 流程。

项目隔离必须在两种场景下都成立。一个 AISA runtime 管多个项目时，项目之间不能串状态。多个 AISA runtime 并行运行时，一个 runtime 不能扫描、推进、修复、阻塞或改写不属于自己的 run。

## 必须满足的行为

AISA 必须支持在不修改 `AISA_DEV_REPO_ROOT` 的情况下 attach 外部项目。`AISA_DEV_REPO_ROOT` 应保留给 AISA 自身开发或 self-bootstrap。外部项目要通过 project attach、project registry，或显式的 project root allowlist 进入。

每个 attached project 都要持久化自己的 workspace scope。run 创建、run launch、drive-run、orchestrator tick、preflight、workspace repair、runtime recovery 都要使用 project 自己的 scope。不能在这些路径里重新从当前 AISA 进程的 dev repo 推导项目边界。

每个 run 都要保存足够的 project 身份，保证后续验证是确定的。至少要保存 attached project id、锁定后的 project workspace root、匹配到的 project scope root，以及拥有这条 run 的 runtime instance 或 runtime data namespace。

orchestrator 不能改写自己无权管理的 run。如果两个 AISA runtime 实例指向同一个 runtime data root，系统要么在启动时 fail closed，给出清楚的锁冲突；要么按 runtime instance ownership 过滤，只能看到和推进自己拥有的 run。它不能扫描所有 run，然后把当前进程的 scope policy 套到别人的 run 上。

managed worktree 必须按 project/run 隔离。推荐形态是 `<managed_root>/<project_slug_or_id>/<run_id>`。即使两个项目 repo 名相同，也必须落到不同 namespace。

`drive-run` 必须和 control-api、orchestrator 使用同一套 project-scoped policy。它不能在驱动 attached project 时退回到 runtime/dev-root-derived scope。

project attach 必须 fail closed。目录不存在、路径不在允许范围内、符号链接逃逸、project profile 损坏、run 和 project root 不匹配，都要明确失败。不能把这些情况当作空状态、stale 状态，或借机重写现场。

runtime promotion 必须从普通 execution 收尾动作里拆出明确边界。AISA 不能因为一轮 execution 产生了 checkpoint，就默认尝试把它 promotion 到 AISA runtime。promotion 只能在 run 明确声明自己是 AISA runtime upgrade 或 self-bootstrap runtime upgrade 时发生，并且必须经过 policy runtime 的显式批准。

外部 project 的 execution 永远不能 promotion 到 AISA runtime。即使外部 project 路径和 AISA dev repo 有父子关系、软链关系、同名 repo，或当前进程误把它识别进 dev root，也只能写入该 project 的 managed worktree 和 project 自己的交付面。

promotion 的默认结果应该是 `not_requested` 或 `skipped_not_runtime_upgrade`，而不是“尝试后再靠 dirty repo 等条件挡住”。脏 repo、非 fast-forward、缺 checkpoint 这些检查仍然必须保留，但它们是第二层保护，不是 promotion 的主要授权条件。

一旦 promotion 会修改 dev repo、runtime repo 或触发 supervisor restart，必须留下清楚的 artifact 和 journal。artifact 至少要包含 promotion requester、approval source、checkpoint sha、dev repo before/after、runtime repo before/after、restart_required 和 skipped/blocked/promoted 的原因。

## 非目标

这份需求不要求所有项目共用一个 managed worktree。每个 project/run 都应该有自己的写入边界。

这份需求也不要求每个项目必须单独启动一个 AISA 进程。一个 runtime 可以管理多个项目，但 project scope 和 run ownership 必须是一等对象。

这份需求不允许任意本地目录无授权运行。项目隔离和显式授权必须同时存在。

## 建议的接口形态

可以引入 `AISA_ALLOWED_PROJECT_ROOTS`，也可以引入持久化 project registry。关键点不是变量名，而是外部项目根目录不能再从 `AISA_DEV_REPO_ROOT` 推导。

可以引入 runtime instance identity，例如 `AISA_RUNTIME_INSTANCE_ID`。这个 identity 可以由环境变量传入，也可以在 runtime data root 首次启动时生成并持久化。run ownership 或等价 lease 里必须能看到它。

operator-facing surface 要把 runtime 路径和 project 路径分开展示。`/health`、run detail、project detail 里都应该能看出哪些目录属于 AISA runtime，哪些目录属于外部 project。

可以给 run 或 policy runtime 增加一个明确字段，例如 `runtime_upgrade_intent`。默认值必须是否定态。只有 `runtime_upgrade_intent=true` 且 `approval_status=approved` 且 attached project 明确是 AISA runtime project 时，promotion 才能进入真正的 git 更新分支。

## 验收标准

AISA 使用自己的 runtime/dev root 启动后，可以通过外部项目授权 attach `/Users/atou/OpenShockSwarm`。attach 成功后，`/health` 仍显示 AISA 是 runtime/dev repo，OpenShock 只出现在 project workspace 字段里。

为 OpenShock 创建并启动 run 后，managed worktree 落在 OpenShock 的 project namespace 下。再 attach 第二个项目时，第二个项目必须有不同的 project id 和 managed worktree namespace。

本机已有的 8787 AISA 实例不能列出、推进、阻塞或改写另一个 runtime 实例创建的 OpenShock run。

如果两个 runtime 实例被错误地指向同一个 runtime data root，而且 identity 或 scope policy 不兼容，系统必须清楚失败。不能把对方的 run 标成 outside scope。

`drive-run` 可以驱动 attached external project run，并使用该 project 持久化的 scope。它不能要求把 `AISA_DEV_REPO_ROOT` 改成目标项目。

坏路径必须明确失败。缺失路径、越界路径、符号链接逃逸、project/run root 不一致，都不能留下 project profile、run、managed worktree 或被重写的状态文件。

AISA self-bootstrap 仍然可用。当 attached project 是 AISA 自己时，它也应该走同一套 project isolation 模型，而不是隐藏绕过校验。

普通 execution 完成后不会自动 promotion。外部项目 execution 完成后不会产生 AISA runtime promotion 请求。AISA 自升级 execution 只有在 run intent 和 policy approval 都满足时，才会尝试 promotion。

## 对抗性验证方案

验收必须主动尝试打破隔离。只证明一个外部项目 happy path attach 成功不够。

### 探针 1：外部项目不能伪装成 dev repo

启动 AISA 时，runtime 和 dev root 都继续指向 AISA。OpenShock 只通过外部项目授权进入。

```bash
CONTROL_API_PORT=18878 \
AISA_RUNTIME_REPO_ROOT=/Users/atou/AISA \
AISA_DEV_REPO_ROOT=/Users/atou/AISA \
AISA_RUNTIME_DATA_ROOT=/tmp/aisa-isolation-runtime-a \
AISA_MANAGED_WORKSPACE_ROOT=/tmp/aisa-isolation-worktrees-a \
AISA_ALLOWED_PROJECT_ROOTS=/Users/atou/OpenShockSwarm \
pnpm --filter @autoresearch/control-api dev
```

然后 attach OpenShock。

```bash
curl -sS -X POST http://127.0.0.1:18878/projects/attach \
  -H 'Content-Type: application/json' \
  --data '{"workspace_root":"/Users/atou/OpenShockSwarm","owner_id":"atou","title":"OpenShockSwarm"}'
```

预期结果是 attach 成功，`/health` 仍显示 AISA 是 runtime/dev repo，run detail 只把 OpenShock 显示为 project workspace。

### 探针 2：一个 runtime 管两个项目

在同一个 runtime 下 attach 两个不同项目，并分别创建 run。

预期结果是两条 run 有不同 project id 和不同 managed worktree namespace。在其中一个 managed worktree 里创建 marker 文件或查看 `git status`，另一个项目不能出现同样变化。启动、修复、暂停 Project A，不能改 Project B 的 current decision、policy runtime、journal、mailbox 或 attempts。

### 探针 3：两个 runtime 实例不能互相污染

启动两个 control-api 实例，给它们不同 runtime instance id，并故意指向同一个 runtime data root。

预期结果是系统在共享 data root 上 fail closed，或者每个实例只能看到和改写自己拥有的 run。绝对不能复现 OpenShock 事件里那种情况：一个实例把另一个实例的 run 标成 outside scope。

### 探针 4：`drive-run` 使用 project scope

创建 OpenShock attached run，然后在 AISA dev root 仍然指向 AISA 的情况下驱动这条 run。

```bash
node --experimental-transform-types --loader ./scripts/ts-runtime-loader.mjs \
  scripts/drive-run.ts \
  --workspace-root /tmp/aisa-isolation-runtime-a \
  --run-id <run_id> \
  --max-polls 2
```

预期结果是 run 不会被标成 outside scope。current decision 里不能出现把 AISA runtime/dev root 当成项目边界的错误信息。

### 探针 5：坏 project root fail closed

分别尝试 attach 一个不存在的路径、一个不在允许范围里的路径、一个通过符号链接逃逸允许范围的路径。

预期结果是全部明确失败。不能产生 project profile，不能产生 run，不能创建 managed worktree，不能重写已有状态。

### 探针 6：并发启动两个项目

同时启动两个不同项目的 run。

预期结果是两条 run 独立推进。某一个项目出现 failure、killswitch、manual-only gate、worker stall 时，另一个项目的 current decision、policy runtime、mailbox、journal、attempts 不发生变化。

### 探针 7：AISA 自开发仍然可用

把 AISA 自己作为 project attach，然后跑现有 self-bootstrap 或 focused run-loop 验证。

预期结果是 self-development 仍然可用，并且走同一套 project isolation 模型。不能存在一条只给 AISA 自己用的隐藏绕过路径。

### 探针 8：普通 execution 不会自动 promotion

创建一条普通 AISA run，让 execution 产生 checkpoint，但不设置 runtime upgrade intent。

预期结果是 runtime-promotion artifact 的状态为 `not_requested` 或 `skipped_not_runtime_upgrade`。dev repo HEAD、runtime repo HEAD 和 supervisor 进程都不变化。journal 不能出现 `attempt.runtime.promotion.promoted`。

### 探针 9：外部项目不能 promotion 到 AISA runtime

Attach 一个外部项目，执行一轮会产生 checkpoint 的 execution。

预期结果是无论 checkpoint 是否存在，都不能尝试更新 AISA dev repo 或 runtime repo。promotion artifact 必须明确写出 `external_project_not_runtime_upgrade` 或等价原因。

### 探针 10：AISA runtime upgrade 必须显式批准

创建一条 AISA 自升级 run，但不批准 runtime upgrade policy。

预期结果是 execution 可以完成，checkpoint 可以存在，但 promotion 停在等待批准或 skipped 状态。批准前不能更新 runtime repo，不能触发 supervisor restart。

然后批准 runtime upgrade policy，重新进入 promotion。

预期结果是只有在 dev repo clean、runtime repo clean、checkpoint fast-forward、runtime upgrade intent 存在且 approval 已通过时，才允许 promotion。promotion 成功后必须留下 artifact 和 restart journal。

### 探针 11：promotion 第二层保护仍然生效

在 runtime upgrade 已批准的情况下，分别制造 dev repo dirty、runtime repo dirty、非 fast-forward checkpoint。

预期结果是每一种都 fail closed。不能部分更新 dev repo 或 runtime repo，不能触发 supervisor restart，artifact 必须写清楚阻塞原因。

## 完成标准

这项改动完成时，以上探针必须被自动化，或至少沉淀为可以直接复制执行的 replay 命令。实现里必须有一个回归测试，能复现这次 cross-instance contamination 的原始失败。

最终验收只能给三种结论。

```text
VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL
```

`PASS` 要求所有项目隔离探针通过。`PARTIAL` 只能用于明确环境限制，不能用于“还没验证完”。
