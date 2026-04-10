import {
  clearCache as rawClearCache,
  layout as rawLayout,
  layoutWithLines as rawLayoutWithLines,
  prepareWithSegments
} from "@chenglou/pretext";

export type PretextPrepared = ReturnType<typeof prepareWithSegments>;

export function supportsTextMeasurement(): boolean {
  if (typeof OffscreenCanvas === "function") {
    return true;
  }

  if (typeof document === "undefined") {
    return false;
  }

  const canvas = document.createElement("canvas");
  return typeof canvas.getContext === "function" && canvas.getContext("2d") !== null;
}

export function prepare({
  text,
  font
}: {
  text: string;
  font: string;
}): PretextPrepared {
  return prepareWithSegments(text, font);
}

export function layout({
  prepared,
  width,
  lineHeight
}: {
  prepared: PretextPrepared;
  width: number;
  lineHeight: number;
}): { height: number; width: number } {
  const result = rawLayout(prepared, width, lineHeight);

  return {
    height: result.height,
    width
  };
}

export function layoutWithLines({
  prepared,
  width,
  maxLines,
  lineHeight
}: {
  prepared: PretextPrepared;
  width: number;
  maxLines: number;
  lineHeight: number;
}): {
  lines: string[];
  truncated: boolean;
} {
  const result = rawLayoutWithLines(prepared, width, lineHeight);
  const truncated = result.lineCount > maxLines;

  return {
    lines: result.lines.slice(0, maxLines).map((line, index) =>
      truncated && index === maxLines - 1 ? `${line.text}...` : line.text
    ),
    truncated
  };
}

export function clearCache(): void {
  rawClearCache();
}
