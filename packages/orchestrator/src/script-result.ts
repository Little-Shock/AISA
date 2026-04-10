type ScriptResultLike = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export function formatScriptFailure(
  label: string,
  result: ScriptResultLike
): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  return [
    `${label} exit code: ${result.exitCode ?? "null"}`,
    stdout.length > 0 ? `stdout:\n${stdout}` : "stdout:\n<empty>",
    stderr.length > 0 ? `stderr:\n${stderr}` : "stderr:\n<empty>"
  ].join("\n\n");
}
