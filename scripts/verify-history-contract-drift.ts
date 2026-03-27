import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAttemptContract,
  getAttemptReviewPacket,
  listAttempts,
  listRuns,
  resolveAttemptPaths,
  resolveWorkspacePaths
} from "../packages/state-store/src/index.ts";

export type HistoryContractDrift = {
  run_id: string;
  attempt_id: string;
  status: string;
  objective_match: boolean;
  success_criteria_match: boolean;
  review_packet_present: boolean;
  review_packet_contract_matches_attempt: boolean;
  meta_file: string;
  contract_file: string;
  review_packet_file: string;
};

export type HistoryContractDriftReport = {
  status: "ok" | "drift_detected";
  summary: string;
  scanned_run_count: number;
  scanned_execution_attempt_count: number;
  drift_count: number;
  drifts: HistoryContractDrift[];
  generated_at: string;
};

const SETTLED_ATTEMPT_STATUSES = new Set(["completed", "failed", "stopped"]);

function matchesStringArray(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export async function buildHistoryContractDriftReport(
  rootDir: string
): Promise<HistoryContractDriftReport> {
  const workspacePaths = resolveWorkspacePaths(rootDir);
  const runs = (await listRuns(workspacePaths)).sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const drifts: HistoryContractDrift[] = [];
  let scannedExecutionAttemptCount = 0;

  for (const run of runs) {
    const attempts = await listAttempts(workspacePaths, run.id);

    for (const attempt of attempts) {
      if (
        attempt.attempt_type !== "execution" ||
        !SETTLED_ATTEMPT_STATUSES.has(attempt.status)
      ) {
        continue;
      }

      const contract = await getAttemptContract(workspacePaths, run.id, attempt.id);
      if (!contract) {
        continue;
      }

      scannedExecutionAttemptCount += 1;

      const reviewPacket = await getAttemptReviewPacket(
        workspacePaths,
        run.id,
        attempt.id
      );
      const attemptPaths = resolveAttemptPaths(workspacePaths, run.id, attempt.id);
      const objectiveMatch = attempt.objective === contract.objective;
      const successCriteriaMatch = matchesStringArray(
        attempt.success_criteria,
        contract.success_criteria
      );
      const reviewPacketPresent = reviewPacket !== null;
      const reviewPacketContractMatchesAttempt =
        reviewPacket?.attempt_contract === null || reviewPacket?.attempt_contract === undefined
          ? true
          : attempt.objective === reviewPacket.attempt_contract.objective &&
            matchesStringArray(
              attempt.success_criteria,
              reviewPacket.attempt_contract.success_criteria
            );

      if (
        objectiveMatch &&
        successCriteriaMatch &&
        reviewPacketContractMatchesAttempt
      ) {
        continue;
      }

      drifts.push({
        run_id: run.id,
        attempt_id: attempt.id,
        status: attempt.status,
        objective_match: objectiveMatch,
        success_criteria_match: successCriteriaMatch,
        review_packet_present: reviewPacketPresent,
        review_packet_contract_matches_attempt: reviewPacketContractMatchesAttempt,
        meta_file: relative(rootDir, attemptPaths.metaFile),
        contract_file: relative(rootDir, attemptPaths.contractFile),
        review_packet_file: relative(rootDir, attemptPaths.reviewPacketFile)
      });
    }
  }

  drifts.sort(
    (left, right) =>
      left.run_id.localeCompare(right.run_id) ||
      left.attempt_id.localeCompare(right.attempt_id)
  );

  const driftCount = drifts.length;

  return {
    status: driftCount > 0 ? "drift_detected" : "ok",
    summary:
      driftCount > 0
        ? `只读扫描发现 ${driftCount} 个历史 execution contract 漂移。`
        : "只读扫描没有发现历史 execution contract 漂移。",
    scanned_run_count: runs.length,
    scanned_execution_attempt_count: scannedExecutionAttemptCount,
    drift_count: driftCount,
    drifts,
    generated_at: new Date().toISOString()
  };
}

async function main(): Promise<void> {
  const report = await buildHistoryContractDriftReport(process.cwd());
  console.log(JSON.stringify(report, null, 2));

  if (report.drift_count > 0) {
    process.exitCode = 1;
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
