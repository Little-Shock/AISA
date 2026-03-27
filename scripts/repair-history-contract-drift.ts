import { AttemptContractSchema, AttemptReviewPacketSchema } from "../packages/domain/src/index.ts";
import {
  getAttempt,
  getAttemptContract,
  getAttemptReviewPacket,
  resolveWorkspacePaths,
  saveAttemptContract,
  saveAttemptReviewPacket
} from "../packages/state-store/src/index.ts";
import {
  buildHistoryContractDriftReport,
  type HistoryContractDrift
} from "./verify-history-contract-drift.ts";

type RepairRecord = {
  run_id: string;
  attempt_id: string;
  repaired_contract: boolean;
  repaired_review_packet: boolean;
};

type RepairReport = {
  status: "noop" | "repaired" | "repair_incomplete";
  summary: string;
  repaired_count: number;
  repairs: RepairRecord[];
  before: {
    drift_count: number;
    drifts: HistoryContractDrift[];
  };
  after: {
    drift_count: number;
    drifts: HistoryContractDrift[];
  };
  generated_at: string;
};

async function repairSingleDrift(
  rootDir: string,
  drift: HistoryContractDrift
): Promise<RepairRecord> {
  const workspacePaths = resolveWorkspacePaths(rootDir);
  const attempt = await getAttempt(workspacePaths, drift.run_id, drift.attempt_id);
  const contract = await getAttemptContract(workspacePaths, drift.run_id, drift.attempt_id);

  if (!contract) {
    throw new Error(
      `Cannot repair ${drift.run_id}/${drift.attempt_id} because attempt_contract.json is missing.`
    );
  }

  const repairedContract = AttemptContractSchema.parse({
    ...contract,
    objective: attempt.objective,
    success_criteria: attempt.success_criteria
  });
  await saveAttemptContract(workspacePaths, repairedContract);

  const reviewPacket = await getAttemptReviewPacket(
    workspacePaths,
    drift.run_id,
    drift.attempt_id
  );

  let repairedReviewPacket = false;
  if (reviewPacket) {
    await saveAttemptReviewPacket(
      workspacePaths,
      AttemptReviewPacketSchema.parse({
        ...reviewPacket,
        attempt_contract: repairedContract,
        generated_at: new Date().toISOString()
      })
    );
    repairedReviewPacket = true;
  }

  return {
    run_id: drift.run_id,
    attempt_id: drift.attempt_id,
    repaired_contract: true,
    repaired_review_packet: repairedReviewPacket
  };
}

async function main(): Promise<void> {
  const rootDir = process.cwd();
  const before = await buildHistoryContractDriftReport(rootDir);

  if (before.drift_count === 0) {
    const report: RepairReport = {
      status: "noop",
      summary: "没有发现需要修复的历史 execution contract 漂移。",
      repaired_count: 0,
      repairs: [],
      before: {
        drift_count: before.drift_count,
        drifts: before.drifts
      },
      after: {
        drift_count: before.drift_count,
        drifts: before.drifts
      },
      generated_at: new Date().toISOString()
    };
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const repairs: RepairRecord[] = [];
  for (const drift of before.drifts) {
    repairs.push(await repairSingleDrift(rootDir, drift));
  }

  const after = await buildHistoryContractDriftReport(rootDir);
  const report: RepairReport = {
    status: after.drift_count === 0 ? "repaired" : "repair_incomplete",
    summary:
      after.drift_count === 0
        ? `已修复 ${repairs.length} 个历史 execution contract 漂移。`
        : `已尝试修复 ${repairs.length} 个历史 execution contract 漂移，但仍剩 ${after.drift_count} 个未收敛。`,
    repaired_count: repairs.length,
    repairs,
    before: {
      drift_count: before.drift_count,
      drifts: before.drifts
    },
    after: {
      drift_count: after.drift_count,
      drifts: after.drifts
    },
    generated_at: new Date().toISOString()
  };

  console.log(JSON.stringify(report, null, 2));
  if (after.drift_count > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
