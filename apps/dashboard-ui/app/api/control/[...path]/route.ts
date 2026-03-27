import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const controlApiTarget =
  process.env.CONTROL_API_PROXY_TARGET ?? "http://127.0.0.1:8787";

function buildUpstreamUrl(request: NextRequest, path: string[]): string {
  const baseUrl = controlApiTarget.endsWith("/")
    ? controlApiTarget.slice(0, -1)
    : controlApiTarget;
  const upstreamUrl = new URL(`${baseUrl}/${path.join("/")}`);
  upstreamUrl.search = new URL(request.url).search;
  return upstreamUrl.toString();
}

function isEventStreamRequest(request: NextRequest, path: string[]): boolean {
  return (
    request.headers.get("accept")?.includes("text/event-stream") === true ||
    path.at(-1) === "stream"
  );
}

async function proxyEventStream(
  upstreamUrl: string,
  request: NextRequest
): Promise<Response> {
  const target = new URL(upstreamUrl);
  const transport = target.protocol === "https:" ? httpsRequest : httpRequest;

  return await new Promise<Response>((resolve, reject) => {
    let upstreamRequest:
      | ReturnType<typeof httpRequest>
      | ReturnType<typeof httpsRequest>
      | null = null;

    upstreamRequest = transport(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers: {
          accept: request.headers.get("accept") ?? "text/event-stream",
          "cache-control": "no-store"
        }
      },
      (upstreamResponse) => {
        const headers = new Headers();
        headers.set(
          "content-type",
          upstreamResponse.headers["content-type"] ?? "text/event-stream; charset=utf-8"
        );
        headers.set(
          "cache-control",
          upstreamResponse.headers["cache-control"] ?? "no-store"
        );
        headers.set("connection", "keep-alive");
        headers.set("x-accel-buffering", "no");

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            upstreamResponse.on("data", (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk));
            });
            upstreamResponse.on("end", () => {
              controller.close();
            });
            upstreamResponse.on("error", (error) => {
              controller.error(error);
            });
          },
          cancel() {
            upstreamRequest?.destroy();
            upstreamResponse.destroy();
          }
        });

        resolve(
          new Response(stream, {
            status: upstreamResponse.statusCode ?? 502,
            headers
          })
        );
      }
    );

    upstreamRequest.on("error", reject);
    upstreamRequest.end();
  });
}

async function proxyRequest(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  const { path } = await context.params;
  const upstreamUrl = buildUpstreamUrl(request, path);

  if (isEventStreamRequest(request, path)) {
    try {
      return await proxyEventStream(upstreamUrl, request);
    } catch (error) {
      return NextResponse.json(
        {
          message:
            error instanceof Error
              ? `控制 API 当前不可用：${error.message}`
              : "控制 API 当前不可用。"
        },
        {
          status: 502,
          headers: {
            "cache-control": "no-store"
          }
        }
      );
    }
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: {
        accept: request.headers.get("accept") ?? "*/*",
        "content-type": request.headers.get("content-type") ?? "application/json"
      },
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.text(),
      cache: "no-store"
    });
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof Error
            ? `控制 API 当前不可用：${error.message}`
            : "控制 API 当前不可用。"
      },
      {
        status: 502,
        headers: {
          "cache-control": "no-store"
        }
      }
    );
  }

  const contentType = upstreamResponse.headers.get("content-type");
  const headers = new Headers();

  if (contentType) {
    headers.set("content-type", contentType);
  }

  const cacheControl = upstreamResponse.headers.get("cache-control");
  if (cacheControl) {
    headers.set("cache-control", cacheControl);
  } else {
    headers.set("cache-control", "no-store");
  }

  return new NextResponse(await upstreamResponse.arrayBuffer(), {
    status: upstreamResponse.status,
    headers
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, context);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, context);
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, context);
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, context);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  return proxyRequest(request, context);
}
