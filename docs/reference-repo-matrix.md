# Reference Repo Matrix

这份矩阵只回答一个问题。

AISA 现在拿哪几类外部仓库做可重复回放的代表样本。

## Node backend

- 参考仓库形态：带 `package.json`、`pnpm-lock.yaml`、`tsconfig.json` 的 Node / TypeScript 后端
- attach 后 `project_type`：`node_repo`
- 推荐 stack pack：`node_backend`
- 默认 task preset：`bugfix`
- 默认 verifier kit：`repo`
- 典型失败模式：`missing_local_verifier_toolchain`
- 恢复路径重点：先明确 repo-local replay 依赖缺失，再走 `first_attempt`，不要在没有本地依赖时直接放 execution
- 验证入口：`pnpm verify:external-repo-matrix`

## Python service

- 参考仓库形态：带 `pyproject.toml` 和 `requirements.txt` 的 Python service
- attach 后 `project_type`：`python_repo`
- 推荐 stack pack：`python_service`
- 默认 task preset：`bugfix`
- 默认 verifier kit：`cli`
- 典型失败模式：`bugfix_regression_unchecked`
- 恢复路径重点：先锁定 replayable CLI 边界，再走 `first_attempt`
- 验证入口：`pnpm verify:external-repo-matrix`

## Go service or CLI

- 参考仓库形态：带 `go.mod` 和 `main.go` 的 Go service / CLI
- attach 后 `project_type`：`go_repo`
- 推荐 stack pack：`go_service_cli`
- 默认 task preset：`bugfix`
- 默认 verifier kit：`cli`
- 典型失败模式：`bugfix_regression_unchecked`
- 恢复路径重点：先锁定 `go test` / `go build` replay，再走 `first_attempt`
- 验证入口：`pnpm verify:external-repo-matrix`

## Repo maintenance

- 参考仓库形态：真实 git 仓库，但没有 Node / Python / Go manifest
- attach 后 `project_type`：`generic_git_repo`
- 推荐 stack pack：`repo_maintenance`
- 默认 task preset：`release_hardening`
- 默认 verifier kit：`repo`
- 典型失败模式：`missing_replayable_verification_plan`
- 恢复路径重点：attach 可以先成功，但 execution 必须保持 fail-closed，直到仓库补出可回放的 maintenance checks；默认 run detail 仍然回到 `first_attempt`
- 验证入口：`pnpm verify:external-repo-matrix`

## 当前回归纪律

- 这四类路径都要能 attach、能创建 project-first run、能在 `/runs/:id` 看到 attached project 与 recovery guidance
- `pnpm verify:external-repo-matrix` 是最窄入口
- `pnpm verify:runtime` 会把它纳入统一主回归，避免这套证明变成一次性演示
