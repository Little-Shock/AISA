"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import { localizeUiText } from "./copy";
import { layoutWithLines, prepare, supportsTextMeasurement } from "./pretext";

function fallbackLineHeight(computedLineHeight: string, fontSize: string): number {
  const parsedLineHeight = Number.parseFloat(computedLineHeight);
  if (Number.isFinite(parsedLineHeight)) {
    return parsedLineHeight;
  }

  const parsedFontSize = Number.parseFloat(fontSize);
  if (Number.isFinite(parsedFontSize)) {
    return parsedFontSize * 1.65;
  }

  return 24;
}

export function MeasuredText({
  text,
  className,
  lines,
  as = "p"
}: {
  text: string;
  className?: string;
  lines: number;
  as?: "p" | "span";
}) {
  const ref = useRef<HTMLParagraphElement | HTMLSpanElement | null>(null);
  const localizedText = localizeUiText(text);
  const [displayLines, setDisplayLines] = useState<string[]>([localizedText]);
  const [minHeight, setMinHeight] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const updateLayout = () => {
      const width = element.clientWidth;
      if (!width) {
        setDisplayLines([localizedText]);
        setMinHeight(null);
        return;
      }

      if (!supportsTextMeasurement()) {
        setDisplayLines([localizedText]);
        setMinHeight(null);
        return;
      }

      const computed = window.getComputedStyle(element);
      const font =
        computed.font ||
        `${computed.fontStyle} ${computed.fontVariant} ${computed.fontWeight} ${computed.fontSize} / ${computed.lineHeight} ${computed.fontFamily}`;
      const prepared = prepare({
        text: localizedText,
        font
      });

      const lineHeight = fallbackLineHeight(computed.lineHeight, computed.fontSize);
      const layout = layoutWithLines({
        prepared,
        width,
        maxLines: lines,
        lineHeight
      });

      setDisplayLines(layout.lines.length > 0 ? layout.lines : [localizedText]);
      setMinHeight(Math.ceil(lineHeight * lines));
    };

    updateLayout();

    const observer = new ResizeObserver(() => {
      updateLayout();
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, [lines, localizedText]);

  if (as === "span") {
    return (
      <span
        ref={ref as Ref<HTMLSpanElement>}
        className={className}
        style={{ minHeight: minHeight ?? undefined }}
        title={localizedText}
      >
        {displayLines.map((line, index) => (
          <Fragment key={`${line}-${index}`}>
            {line}
            {index < displayLines.length - 1 ? <br /> : null}
          </Fragment>
        ))}
      </span>
    );
  }

  return (
    <p
      ref={ref as Ref<HTMLParagraphElement>}
      className={className}
      style={{ minHeight: minHeight ?? undefined }}
      title={localizedText}
    >
      {displayLines.map((line, index) => (
        <Fragment key={`${line}-${index}`}>
          {line}
          {index < displayLines.length - 1 ? <br /> : null}
        </Fragment>
      ))}
    </p>
  );
}
