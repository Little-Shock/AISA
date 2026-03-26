import assert from "node:assert/strict";
import copy from "../apps/dashboard-ui/app/copy.ts";

const {
  activityLabel,
  localizeUiText,
  nextActionLabel,
  statusLabel
} = copy;

function main(): void {
  assert.equal(localizeUiText("AISA self-bootstrap next-step planning"), "AISA 自举下一步规划");
  assert.equal(statusLabel("wait_for_human"), "等待人工");
  assert.equal(nextActionLabel("continue_execution"), "继续执行");
  assert.equal(activityLabel("worker.finished"), "执行器已完成");

  const recovered = localizeUiText(
    "Attempt att_demo was still marked running when the orchestrator resumed. Recovery requires human review before retry."
  );
  assert.equal(recovered, "尝试 att_demo 在编排器恢复时仍被标记为运行中。重试前需要人工确认恢复。");

  const stderr = localizeUiText(
    "Codex CLI exited with code 1 for attempt att_demo Worker stderr: invalid token"
  );
  assert.match(stderr, /Codex CLI 在尝试 att_demo 上以退出码 1 结束/);
  assert.match(stderr, /执行器错误输出： invalid token/);

  console.log(
    JSON.stringify(
      {
        status: "passed",
        sample_title: localizeUiText("AISA self-bootstrap next-step planning"),
        sample_error: stderr
      },
      null,
      2
    )
  );
}

main();
