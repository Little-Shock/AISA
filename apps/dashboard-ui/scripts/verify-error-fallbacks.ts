import assert from "node:assert/strict";
import { readErrorMessage } from "../app/error-response";
import { prepare, supportsTextMeasurement } from "../app/pretext";

async function main(): Promise<void> {
  assert.equal(
    supportsTextMeasurement(),
    false,
    "node verify runtime should not pretend dashboard text measurement is available"
  );

  await assert.rejects(
    async () => {
      prepare({
        text: "hello",
        font: "12px Arial"
      });
    },
    /OffscreenCanvas|canvas context/i
  );

  assert.equal(
    await readErrorMessage(
      new Response(JSON.stringify({ message: "控制 API 当前不可用" }), {
        headers: {
          "content-type": "application/json"
        }
      }),
      "fallback"
    ),
    "控制 API 当前不可用"
  );

  assert.equal(
    await readErrorMessage(
      new Response("plain text failure", {
        headers: {
          "content-type": "text/plain"
        }
      }),
      "fallback"
    ),
    "fallback"
  );

  await assert.rejects(
    async () => {
      await readErrorMessage(
        new Response("{", {
          headers: {
            "content-type": "application/json"
          }
        }),
        "fallback"
      );
    },
    /JSON|Unexpected|property name/i
  );

  console.log(
    JSON.stringify(
      {
        suite: "dashboard-error-fallbacks",
        status: "passed"
      },
      null,
      2
    )
  );
}

void main();
