export type DangerousVerificationCommandFinding = {
  command: string;
  rule:
    | "destructive_git_reset"
    | "destructive_git_checkout"
    | "destructive_git_clean"
    | "destructive_rm";
};

const DANGEROUS_VERIFICATION_COMMAND_PATTERNS: Array<{
  rule: Exclude<DangerousVerificationCommandFinding["rule"], "destructive_rm">;
  pattern: RegExp;
}> = [
  {
    rule: "destructive_git_reset",
    pattern: /(^|[;&|]\s*)git\s+reset\s+--hard(\s|$)/i
  },
  {
    rule: "destructive_git_checkout",
    pattern: /(^|[;&|]\s*)git\s+checkout\s+--(\s|$)/i
  },
  {
    rule: "destructive_git_clean",
    pattern: /(^|[;&|]\s*)git\s+clean\s+-[^\n]*f/i
  }
];

export function findDangerousVerificationCommand(
  commands: string[]
): DangerousVerificationCommandFinding | null {
  for (const command of commands) {
    const normalized = command.trim().replace(/\s+/g, " ");
    for (const candidate of DANGEROUS_VERIFICATION_COMMAND_PATTERNS) {
      if (candidate.pattern.test(normalized)) {
        return {
          command: normalized,
          rule: candidate.rule
        };
      }
    }

    for (const segment of splitShellSegments(normalized)) {
      if (!isRecursiveForceRmSegment(segment)) continue;
      if (isReplaySafeTemporaryRmSegment(segment)) continue;
      return {
        command: segment,
        rule: "destructive_rm"
      };
    }
  }

  return null;
}

export function canCheckpointMitigateDangerousCommand(
  finding: DangerousVerificationCommandFinding
): boolean {
  switch (finding.rule) {
    case "destructive_git_reset":
      return isHeadOnlyHardResetCommand(finding.command);
    case "destructive_git_clean":
      return isGitCleanWithoutIgnoredFiles(finding.command);
    case "destructive_git_checkout":
      return true;
    case "destructive_rm":
      return false;
  }
}

function splitShellSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;&]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

function parseSimpleShellWords(segment: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  const pushCurrent = () => {
    if (current !== "") {
      words.push(current);
      current = "";
    }
  };

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\") {
        return null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "\\") return null;
    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }
    current += char;
  }

  if (quote) return null;
  pushCurrent();
  return words;
}

function isRecursiveForceRmSegment(segment: string): boolean {
  const words = parseSimpleShellWords(segment);
  if (!words) {
    return /^rm\s+/i.test(segment) && /\s-[^\s]*r/i.test(segment) && /\s-[^\s]*f/i.test(segment);
  }
  if (words[0] !== "rm") return false;

  const optionTokens = words.slice(1).filter((word) => word.startsWith("-"));
  return optionTokens.some((word) => {
    if (word.startsWith("--")) {
      return word === "--recursive" || word === "--force";
    }
    return word.includes("r") && word.includes("f");
  }) || (
    optionTokens.some((word) => word === "-r" || word === "-R" || word === "--recursive") &&
    optionTokens.some((word) => word === "-f" || word === "--force")
  );
}

function isReplaySafeTemporaryRmSegment(segment: string): boolean {
  const words = parseSimpleShellWords(segment);
  if (!words || words[0] !== "rm") return false;
  if (!isRecursiveForceRmSegment(segment)) return false;

  const targets = words.slice(1).filter((word) => !word.startsWith("-"));
  return targets.length > 0 && targets.every(isReplaySafeTemporaryPath);
}

function isReplaySafeTemporaryPath(target: string): boolean {
  if (!target.startsWith("/tmp/")) return false;
  if (target.length <= "/tmp/".length) return false;
  if (/[$*?[\]{}~`\\!;|&<>]/.test(target)) return false;

  const segments = target.slice("/tmp/".length).split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isHeadOnlyHardResetCommand(command: string): boolean {
  return splitShellSegments(command).some((segment) => {
    const words = parseSimpleShellWords(segment);
    if (!words || words[0] !== "git" || words[1] !== "reset") return false;
    const hardIndex = words.indexOf("--hard");
    if (hardIndex < 0) return false;
    const targets = words.slice(hardIndex + 1).filter((word) => !word.startsWith("-"));
    return targets.length === 0 || (targets.length === 1 && targets[0] === "HEAD");
  });
}

function isGitCleanWithoutIgnoredFiles(command: string): boolean {
  return splitShellSegments(command).some((segment) => {
    const words = parseSimpleShellWords(segment);
    if (!words || words[0] !== "git" || words[1] !== "clean") return false;
    const options = words.slice(2).filter((word) => word.startsWith("-"));
    return !options.some((option) => {
      if (!option.startsWith("-") || option.startsWith("--")) return false;
      return option.slice(1).includes("x") || option.slice(1).includes("X");
    });
  });
}
