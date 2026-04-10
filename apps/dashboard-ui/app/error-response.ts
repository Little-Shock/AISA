function isJsonResponse(response: Response): boolean {
  return response.headers.get("content-type")?.includes("application/json") === true;
}

export async function readErrorMessage(
  response: Response,
  fallback: string
): Promise<string> {
  if (!isJsonResponse(response)) {
    return fallback;
  }

  const payload = (await response.json()) as {
    message?: unknown;
  };

  return typeof payload.message === "string" && payload.message.trim().length > 0
    ? payload.message
    : fallback;
}
