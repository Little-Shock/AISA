"use client";

import { startTransition, useEffect, useMemo, useState } from "react";

type GoalSummaryItem = {
  goal: {
    id: string;
    title: string;
    status: string;
    workspace_root: string;
  };
  branch_count: number;
  running_count: number;
  kept_count: number;
};

type GoalDetail = {
  goal: {
    id: string;
    title: string;
    description: string;
    status: string;
    workspace_root: string;
    success_criteria: string[];
    constraints: string[];
  };
  branches: Array<{
    branch: {
      id: string;
      hypothesis: string;
      objective: string;
      status: string;
      assigned_worker: string;
      score: number | null;
      confidence: number | null;
    };
    writeback: {
      summary: string;
      recommended_next_steps: string[];
    } | null;
  }>;
  steers: Array<{
    id: string;
    content: string;
    status: string;
    scope: string;
  }>;
  context: {
    shared_facts: string[];
    open_questions: string[];
    constraints: string[];
    branch_notes: Record<string, string>;
  };
  report: string;
  events: Array<{
    event_id: string;
    type: string;
    ts: string;
  }>;
};

const apiBaseUrl =
  process.env.NEXT_PUBLIC_CONTROL_API_URL ?? "http://127.0.0.1:8787";
const defaultWorkspace =
  process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE_ROOT ??
  "E:\\00.Lark_Projects\\36_team_research";

export default function Page() {
  const [goals, setGoals] = useState<GoalSummaryItem[]>([]);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GoalDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [goalForm, setGoalForm] = useState({
    title: "把当前仓库收敛成下一步实施计划",
    description:
      "让多个 Codex CLI 分支围绕同一目标并行分析仓库、共享上下文，并产出当前最优报告。",
    success_criteria:
      "明确推荐路径\n指出关键风险\n给出下一步实施动作",
    constraints:
      "只读分析\n文件系统优先\n不要脱离当前 PRD\n不要给出无证据结论",
    owner_id: "owner_001",
    workspace_root: defaultWorkspace
  });
  const [steerText, setSteerText] = useState("");

  useEffect(() => {
    void loadGoals();
  }, []);

  useEffect(() => {
    if (!selectedGoalId) {
      return;
    }

    void loadDetail(selectedGoalId);
    const timer = window.setInterval(() => {
      void loadGoals();
      void loadDetail(selectedGoalId);
    }, 4000);

    return () => window.clearInterval(timer);
  }, [selectedGoalId]);

  const selectedGoal = useMemo(
    () => goals.find((item) => item.goal.id === selectedGoalId) ?? null,
    [goals, selectedGoalId]
  );

  const overviewStats = useMemo(() => {
    const totalGoals = goals.length;
    const runningGoals = goals.filter((item) => item.goal.status === "running").length;
    const activeBranches = goals.reduce((sum, item) => sum + item.running_count, 0);
    const keptBranches = goals.reduce((sum, item) => sum + item.kept_count, 0);

    return [
      { label: "目标总数", value: String(totalGoals).padStart(2, "0") },
      { label: "运行中目标", value: String(runningGoals).padStart(2, "0") },
      { label: "活跃分支", value: String(activeBranches).padStart(2, "0") },
      { label: "已保留分支", value: String(keptBranches).padStart(2, "0") }
    ];
  }, [goals]);

  async function loadGoals() {
    const response = await fetch(`${apiBaseUrl}/goals`);
    const payload = (await response.json()) as { goals: GoalSummaryItem[] };
    setGoals(payload.goals);

    if (!selectedGoalId && payload.goals.length > 0) {
      startTransition(() => {
        setSelectedGoalId(payload.goals[0].goal.id);
      });
    }
  }

  async function loadDetail(goalId: string) {
    const response = await fetch(`${apiBaseUrl}/goals/${goalId}`);
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as GoalDetail;
    setDetail(payload);
  }

  async function createGoal() {
    setBusy("create");
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: goalForm.title,
          description: goalForm.description,
          success_criteria: splitLines(goalForm.success_criteria),
          constraints: splitLines(goalForm.constraints),
          owner_id: goalForm.owner_id,
          workspace_root: goalForm.workspace_root
        })
      });

      if (!response.ok) {
        throw new Error("创建目标失败");
      }

      const payload = (await response.json()) as { goal: { id: string } };
      await loadGoals();
      setSelectedGoalId(payload.goal.id);
      await loadDetail(payload.goal.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function launchGoal(goalId: string) {
    setBusy(`launch:${goalId}`);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/goals/${goalId}/launch`, {
        method: "POST"
      });

      if (!response.ok) {
        throw new Error("启动目标失败");
      }

      await loadGoals();
      await loadDetail(goalId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function rerunBranch(goalId: string, branchId: string) {
    setBusy(`rerun:${branchId}`);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/goals/${goalId}/branches/${branchId}/rerun`, {
        method: "POST"
      });

      if (!response.ok) {
        throw new Error("重跑分支失败");
      }

      await loadDetail(goalId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function queueSteer(goalId: string) {
    if (!steerText.trim()) {
      return;
    }

    setBusy(`steer:${goalId}`);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/goals/${goalId}/steers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "goal",
          content: steerText.trim()
        })
      });

      if (!response.ok) {
        throw new Error("提交 steer 失败");
      }

      setSteerText("");
      await loadDetail(goalId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="dashboard-shell">
      <div className="dashboard-frame">
        <section className="hero-panel">
          <div className="hero-copy">
            <div className="hero-eyebrow">AutoResearch / 中文控制台</div>
            <h1 className="hero-title">
              多 Agent 研究总控台
              <span>不是聊天页，是任务编排与收敛面板。</span>
            </h1>
            <p className="hero-description">
              围绕一个目标同时启动多个 Codex 分支，沉淀共享上下文、插入人工 steer，
              再用评分与报告把探索过程压成可执行结论。
            </p>
          </div>

          <div className="hero-meta">
            <div className="meta-card">
              <span className="meta-label">控制 API</span>
              <strong>{apiBaseUrl}</strong>
            </div>
            <div className="meta-card">
              <span className="meta-label">默认工作区</span>
              <strong>{defaultWorkspace}</strong>
            </div>
          </div>

          <div className="stats-row">
            {overviewStats.map((stat) => (
              <article key={stat.label} className="stat-card">
                <span className="stat-label">{stat.label}</span>
                <strong className="stat-value">{stat.value}</strong>
              </article>
            ))}
          </div>
        </section>

        {error ? <section className="error-banner">{error}</section> : null}

        <div className="content-grid">
          <aside className="left-rail">
            <Panel
              title="发起新目标"
              subtitle="把一个高层问题收束成可并行探索的研究任务。"
            >
              <div className="form-stack">
                <Field
                  label="目标标题"
                  value={goalForm.title}
                  onChange={(value) => setGoalForm((current) => ({ ...current, title: value }))}
                />
                <TextAreaField
                  label="问题描述"
                  value={goalForm.description}
                  onChange={(value) =>
                    setGoalForm((current) => ({ ...current, description: value }))
                  }
                />
                <TextAreaField
                  label="成功标准"
                  value={goalForm.success_criteria}
                  onChange={(value) =>
                    setGoalForm((current) => ({ ...current, success_criteria: value }))
                  }
                />
                <TextAreaField
                  label="约束条件"
                  value={goalForm.constraints}
                  onChange={(value) =>
                    setGoalForm((current) => ({ ...current, constraints: value }))
                  }
                />
                <Field
                  label="Owner"
                  value={goalForm.owner_id}
                  onChange={(value) =>
                    setGoalForm((current) => ({ ...current, owner_id: value }))
                  }
                />
                <Field
                  label="工作区路径"
                  value={goalForm.workspace_root}
                  onChange={(value) =>
                    setGoalForm((current) => ({ ...current, workspace_root: value }))
                  }
                />
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void createGoal()}
                  disabled={busy === "create"}
                >
                  {busy === "create" ? "创建中..." : "创建目标"}
                </button>
              </div>
            </Panel>

            <Panel
              title={`目标池 · ${goals.length}`}
              subtitle="这里展示所有 goal 的整体推进状态。"
            >
              <div className="goal-list">
                {goals.length === 0 ? (
                  <EmptyState text="还没有目标。先在上方创建一个，然后启动第一轮分支。" />
                ) : (
                  goals.map((item) => {
                    const selected = item.goal.id === selectedGoalId;
                    return (
                      <button
                        key={item.goal.id}
                        type="button"
                        className={`goal-card${selected ? " is-selected" : ""}`}
                        onClick={() => {
                          setSelectedGoalId(item.goal.id);
                          void loadDetail(item.goal.id);
                        }}
                      >
                        <div className="goal-card-head">
                          <strong>{item.goal.title}</strong>
                          <StatusPill value={item.goal.status} />
                        </div>
                        <div className="goal-card-body">{item.goal.workspace_root}</div>
                        <div className="goal-card-meta">
                          分支 {item.branch_count} · 运行中 {item.running_count} · 已保留{" "}
                          {item.kept_count}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </Panel>
          </aside>

          <section className="main-stage">
            {detail && selectedGoal ? (
              <>
                <Panel
                  title={detail.goal.title}
                  subtitle="目标简报、状态总览、人工 steer 都集中在这一屏。"
                  actions={
                    <div className="action-row">
                      <button
                        type="button"
                        className="button button-primary"
                        onClick={() => void launchGoal(detail.goal.id)}
                        disabled={busy === `launch:${detail.goal.id}`}
                      >
                        {busy === `launch:${detail.goal.id}` ? "启动中..." : "启动编排"}
                      </button>
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => {
                          void loadGoals();
                          void loadDetail(detail.goal.id);
                        }}
                      >
                        刷新
                      </button>
                    </div>
                  }
                >
                  <div className="summary-grid">
                    <InfoCard label="目标状态" value={statusLabel(detail.goal.status)} />
                    <InfoCard label="工作区" value={detail.goal.workspace_root} />
                    <InfoCard label="分支数量" value={String(detail.branches.length)} />
                    <InfoCard label="事件条数" value={String(detail.events.length)} />
                  </div>

                  <div className="dual-grid">
                    <SubPanel title="任务简报" accent="emerald">
                      <p className="body-copy">{detail.goal.description}</p>
                      <SectionList title="成功标准" items={detail.goal.success_criteria} />
                      <SectionList title="约束条件" items={detail.goal.constraints} />
                    </SubPanel>

                    <SubPanel title="人工 Steer" accent="amber">
                      <TextAreaField
                        label="新的 steer 指令"
                        value={steerText}
                        onChange={setSteerText}
                        placeholder="例如：下一轮优先比较状态模型和事件模型，不要继续讨论 UI。"
                      />
                      <button
                        type="button"
                        className="button button-secondary wide"
                        onClick={() => void queueSteer(detail.goal.id)}
                        disabled={busy === `steer:${detail.goal.id}`}
                      >
                        {busy === `steer:${detail.goal.id}` ? "提交中..." : "加入 Steer 队列"}
                      </button>
                      <SectionList
                        title="队列 / 已应用"
                        items={detail.steers.map(
                          (steer) => `[${statusLabel(steer.status)}] ${steer.content}`
                        )}
                      />
                    </SubPanel>
                  </div>
                </Panel>

                <div className="dual-grid">
                  <Panel
                    title="分支看板"
                    subtitle="每个 branch 都是一个独立的研究假设与工作线程。"
                  >
                    <div className="branch-list">
                      {detail.branches.map(({ branch, writeback }) => (
                        <article key={branch.id} className="branch-card">
                          <div className="branch-head">
                            <div>
                              <div className="branch-id">{branch.id}</div>
                              <div className="branch-meta">
                                worker {branch.assigned_worker} · 分数{" "}
                                {branch.score !== null ? branch.score.toFixed(2) : "--"}
                              </div>
                            </div>
                            <StatusPill value={branch.status} />
                          </div>
                          <p className="branch-hypothesis">{branch.hypothesis}</p>
                          <p className="branch-summary">
                            {writeback?.summary ?? branch.objective}
                          </p>
                          <div className="action-row">
                            <button
                              type="button"
                              className="button button-ghost"
                              onClick={() => void rerunBranch(detail.goal.id, branch.id)}
                              disabled={busy === `rerun:${branch.id}`}
                            >
                              {busy === `rerun:${branch.id}` ? "排队中..." : "重跑分支"}
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </Panel>

                  <Panel
                    title="当前最优报告"
                    subtitle="系统会把分支结果压缩成一份持续更新的当前版本。"
                  >
                    <pre className="report-block">
                      {detail.report || "还没有报告。请先启动目标，让 Codex 分支开始执行。"}
                    </pre>
                  </Panel>
                </div>

                <div className="dual-grid">
                  <Panel
                    title="共享上下文板"
                    subtitle="把事实、问题、约束从各分支回写到共享面板。"
                  >
                    <SectionList title="共享事实" items={detail.context.shared_facts} />
                    <SectionList title="开放问题" items={detail.context.open_questions} />
                  </Panel>

                  <Panel
                    title="事件时间线"
                    subtitle="所有关键动作都记录为可追踪的运行事实。"
                  >
                    <div className="event-list">
                      {detail.events.slice(-16).reverse().map((event) => (
                        <article key={event.event_id} className="event-row">
                          <strong>{eventLabel(event.type)}</strong>
                          <span>{new Date(event.ts).toLocaleString("zh-CN")}</span>
                        </article>
                      ))}
                    </div>
                  </Panel>
                </div>
              </>
            ) : (
              <Panel
                title="还没有选中目标"
                subtitle="先从左侧目标池里选一个，或者直接创建新目标。"
              >
                <EmptyState text="这块区域会展示目标概览、分支看板、共享上下文、实时报告和事件时间线。" />
              </Panel>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    draft: "草稿",
    planned: "已规划",
    running: "运行中",
    waiting_steer: "等待 Steer",
    reviewing: "评审中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    created: "已创建",
    queued: "排队中",
    writing_back: "回写中",
    judging: "评分中",
    kept: "已保留",
    discarded: "已丢弃",
    respawned: "待重启",
    stopped: "已停止",
    applied: "已应用",
    expired: "已过期"
  };

  return labels[value] ?? value;
}

function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    "goal.created": "目标已创建",
    "plan.generated": "计划已生成",
    "branch.spawned": "分支已生成",
    "branch.queued": "分支已排队",
    "worker.started": "Worker 已启动",
    "worker.finished": "Worker 已完成",
    "worker.failed": "Worker 执行失败",
    "judge.completed": "评估已完成",
    "report.updated": "报告已更新",
    "steer.queued": "Steer 已排队",
    "steer.applied": "Steer 已应用",
    "goal.completed": "目标已结束"
  };

  return labels[type] ?? type;
}

function Panel({
  title,
  subtitle,
  children,
  actions
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">{title}</h2>
          {subtitle ? <p className="panel-subtitle">{subtitle}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function SubPanel({
  title,
  accent,
  children
}: {
  title: string;
  accent: "emerald" | "amber";
  children: React.ReactNode;
}) {
  return (
    <div className={`sub-panel sub-panel-${accent}`}>
      <h3 className="sub-panel-title">{title}</h3>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="field-input"
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <textarea
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="field-textarea"
        rows={4}
      />
    </label>
  );
}

function StatusPill({ value }: { value: string }) {
  return <span className={`status-pill status-${value}`}>{statusLabel(value)}</span>;
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="info-card">
      <span className="info-label">{label}</span>
      <strong className="info-value">{value}</strong>
    </article>
  );
}

function SectionList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="section-list">
      <div className="section-list-title">{title}</div>
      <ul>
        {(items.length > 0 ? items : ["暂无内容"]).map((item) => (
          <li key={`${title}-${item}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="empty-state">{text}</p>;
}
