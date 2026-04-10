import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const VERIFY_GITIGNORE_CONTENT =
  ["runs/", "state/", "events/", "artifacts/", "reports/", "plans/"].join("\n") +
  "\n";

export async function initializeVerifyGitRepo(input: {
  rootDir: string;
  readme: string;
  userName: string;
  userEmail: string;
  commitMessage: string;
  runCommand: (rootDir: string, args: string[]) => Promise<unknown>;
}): Promise<void> {
  await writeFile(join(input.rootDir, ".gitignore"), VERIFY_GITIGNORE_CONTENT, "utf8");
  await writeFile(join(input.rootDir, "README.md"), input.readme, "utf8");
  await input.runCommand(input.rootDir, ["git", "-C", input.rootDir, "init"]);
  await input.runCommand(input.rootDir, [
    "git",
    "-C",
    input.rootDir,
    "config",
    "user.name",
    input.userName
  ]);
  await input.runCommand(input.rootDir, [
    "git",
    "-C",
    input.rootDir,
    "config",
    "user.email",
    input.userEmail
  ]);
  await input.runCommand(input.rootDir, ["git", "-C", input.rootDir, "add", "."]);
  await input.runCommand(input.rootDir, [
    "git",
    "-C",
    input.rootDir,
    "commit",
    "-m",
    input.commitMessage
  ]);
}
