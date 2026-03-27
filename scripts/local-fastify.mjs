import { createServer } from "node:http";
import { EventEmitter } from "node:events";

function buildRouteMatcher(path) {
  const segments = path
    .split("/")
    .filter((segment) => segment.length > 0);

  return (pathname) => {
    const candidateSegments = pathname
      .split("/")
      .filter((segment) => segment.length > 0);
    if (candidateSegments.length !== segments.length) {
      return null;
    }

    const params = {};
    for (let index = 0; index < segments.length; index += 1) {
      const expected = segments[index];
      const actual = candidateSegments[index];

      if (expected.startsWith(":")) {
        params[expected.slice(1)] = decodeURIComponent(actual);
        continue;
      }

      if (expected !== actual) {
        return null;
      }
    }

    return params;
  };
}

function serializePayload(payload) {
  if (payload === undefined) {
    return {
      body: "",
      contentType: "text/plain; charset=utf-8"
    };
  }

  if (typeof payload === "string") {
    return {
      body: payload,
      contentType: "text/plain; charset=utf-8"
    };
  }

  return {
    body: JSON.stringify(payload),
    contentType: "application/json; charset=utf-8"
  };
}

function createReply(raw) {
  const state = {
    statusCode: 200,
    headers: {},
    sent: false,
    hijacked: false,
    payload: undefined
  };

  const reply = {
    raw,
    code(statusCode) {
      state.statusCode = statusCode;
      return reply;
    },
    header(name, value) {
      state.headers[name.toLowerCase()] = value;
      return reply;
    },
    send(payload) {
      state.sent = true;
      state.payload = payload;
      return reply;
    },
    hijack() {
      state.hijacked = true;
      return reply;
    }
  };

  return {
    reply,
    state
  };
}

async function readRequestBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export default function Fastify() {
  const routes = [];
  const hooks = {
    onListen: [],
    onClose: []
  };
  const log = {
    info() {},
    warn() {},
    error() {}
  };
  let server = null;
  let listening = false;
  let closing = false;

  async function dispatch(input) {
    const matched = routes.find((route) => (
      route.method === input.method &&
      route.match(input.pathname) !== null
    ));

    if (!matched) {
      return {
        statusCode: 404,
        headers: {
          "content-type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
          message: `Route ${input.method} ${input.pathname} not found`
        })
      };
    }

    const params = matched.match(input.pathname);
    const { reply, state } = createReply(input.rawReply);
    const request = {
      method: input.method,
      url: input.pathname,
      params,
      body: input.body,
      raw: input.rawRequest
    };

    try {
      const result = await matched.handler(request, reply);

      if (state.hijacked) {
        return {
          hijacked: true
        };
      }

      if (!state.sent) {
        state.payload = result;
      }

      const serialized = serializePayload(state.payload);
      return {
        statusCode: state.statusCode,
        headers: {
          "content-type": serialized.contentType,
          ...state.headers
        },
        body: serialized.body
      };
    } catch (error) {
      return {
        statusCode: 500,
        headers: {
          "content-type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
          message: error instanceof Error ? error.message : String(error)
        })
      };
    }
  }

  async function runCloseHooks() {
    for (const hook of hooks.onClose) {
      await hook();
    }
  }

  return {
    log,
    async register(plugin, options) {
      if (typeof plugin === "function") {
        await plugin(this, options);
      }
      return this;
    },
    addHook(name, hook) {
      if (!(name in hooks)) {
        throw new Error(`Unsupported hook: ${name}`);
      }

      hooks[name].push(hook);
      return this;
    },
    get(path, handler) {
      routes.push({
        method: "GET",
        path,
        match: buildRouteMatcher(path),
        handler
      });
      return this;
    },
    post(path, handler) {
      routes.push({
        method: "POST",
        path,
        match: buildRouteMatcher(path),
        handler
      });
      return this;
    },
    async inject(input) {
      const url = new URL(input.url, "http://local.test");
      const rawRequest = {
        on() {
          return rawRequest;
        }
      };
      const rawReply = {};
      const response = await dispatch({
        method: input.method.toUpperCase(),
        pathname: url.pathname,
        body: input.payload,
        rawRequest,
        rawReply
      });

      return {
        statusCode: response.statusCode ?? 500,
        body: response.body ?? "",
        headers: response.headers ?? {},
        json() {
          return JSON.parse(response.body ?? "null");
        }
      };
    },
    async injectStream(input) {
      const url = new URL(input.url, "http://local.test");
      const rawRequest = new EventEmitter();
      let responseClosed = false;
      let responseSent = false;

      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      response.setEncoding = () => response;
      response.destroy = () => {
        if (responseClosed) {
          return response;
        }

        responseClosed = true;
        rawRequest.emit("close");
        response.emit("end");
        return response;
      };

      const request = new EventEmitter();
      request.destroy = () => {
        rawRequest.emit("close");
        response.destroy();
        return request;
      };

      const emitResponse = () => {
        if (responseSent) {
          return;
        }

        responseSent = true;
        request.emit("response", response);
      };

      const rawReply = {
        writeHead(statusCode, headers = {}) {
          response.statusCode = statusCode;
          response.headers = headers;
          emitResponse();
          return rawReply;
        },
        write(chunk) {
          emitResponse();
          response.emit(
            "data",
            typeof chunk === "string" ? chunk : String(chunk)
          );
          return true;
        },
        end(chunk) {
          if (chunk !== undefined) {
            rawReply.write(chunk);
          } else {
            emitResponse();
          }

          if (!responseClosed) {
            responseClosed = true;
            response.emit("end");
          }

          return rawReply;
        }
      };

      request.end = () => {
        void dispatch({
          method: input.method.toUpperCase(),
          pathname: url.pathname,
          body: input.payload,
          rawRequest,
          rawReply
        })
          .then((dispatchResult) => {
            if (dispatchResult.hijacked) {
              emitResponse();
              return;
            }

            rawReply.writeHead(
              dispatchResult.statusCode ?? 500,
              dispatchResult.headers ?? {}
            );
            rawReply.end(dispatchResult.body ?? "");
          })
          .catch((error) => {
            request.emit("error", error);
          });
      };

      return {
        request,
        response
      };
    },
    async listen(options) {
      if (typeof options.path === "string") {
        listening = true;

        for (const hook of hooks.onListen) {
          await hook();
        }

        return options.path;
      }

      if (listening) {
        return "";
      }

      server = createServer(async (req, res) => {
        const body = await readRequestBody(req);
        const rawRequest = {
          on(event, listener) {
            if (event === "close") {
              req.on("close", listener);
            }
            return rawRequest;
          }
        };
        const response = await dispatch({
          method: (req.method ?? "GET").toUpperCase(),
          pathname: new URL(req.url ?? "/", "http://local.test").pathname,
          body,
          rawRequest,
          rawReply: res
        });

        if (response.hijacked) {
          return;
        }

        res.writeHead(response.statusCode ?? 500, response.headers ?? {});
        res.end(response.body ?? "");
      });

      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options, resolve);
      });
      listening = true;

      for (const hook of hooks.onListen) {
        await hook();
      }

      if (typeof options.port === "number") {
        return `http://${options.host ?? "127.0.0.1"}:${options.port}`;
      }

      return typeof options.path === "string" ? options.path : "";
    },
    async close() {
      if (closing) {
        return;
      }

      closing = true;
      if (server && listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
      listening = false;
      server = null;
      await runCloseHooks();
    }
  };
}
