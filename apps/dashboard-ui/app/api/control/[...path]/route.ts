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

async function proxyRequest(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const { path } = await context.params;
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(buildUpstreamUrl(request, path), {
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

  const body = await upstreamResponse.arrayBuffer();
  const response = new NextResponse(body, {
    status: upstreamResponse.status
  });

  const contentType = upstreamResponse.headers.get("content-type");
  if (contentType) {
    response.headers.set("content-type", contentType);
  }

  const cacheControl = upstreamResponse.headers.get("cache-control");
  if (cacheControl) {
    response.headers.set("cache-control", cacheControl);
  } else {
    response.headers.set("cache-control", "no-store");
  }

  return response;
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
