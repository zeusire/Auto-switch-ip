import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import {
  OPENCODE_SESSION_RE,
  resetOpencodeSessionRotation,
} from "../../open-sse/executors/opencode.js";

// The free tier meters quota per upstream session, so one session eventually
// answers 429 on every request while the account and IP stay healthy. Before
// this, only a process restart minted a new session — the exhausted one was
// pinned in RAM for the lifetime of the process.

function makeCredentials(overrides = {}) {
  return { connectionId: "conn_rotate", rawHeaders: {}, ...overrides };
}

function jsonResponse(status, body = "{}") {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function execute(executor, overrides = {}) {
  return executor.execute({
    model: "nemotron-3-ultra-free",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: true,
    credentials: overrides.credentials || makeCredentials(),
    providerSessionId: overrides.providerSessionId ?? "conversation-rotate",
    clientTool: overrides.clientTool ?? "claude",
    log: { debug: () => { } },
  });
}

function sessionOfCall(index) {
  return fetchMock.mock.calls[index][1].headers["x-opencode-session"];
}

beforeEach(() => {
  fetchMock.mockReset();
  resetOpencodeSessionRotation();
});

describe("OpenCode session rotation on 429", () => {
  it("re-mints the session and retries once when upstream reports a session quota 429", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, JSON.stringify({
        error: { type: "FreeUsageLimitError", message: "Free usage limit reached" },
      })))
      .mockResolvedValueOnce(jsonResponse(200, "{}"));

    const executor = getExecutor("opencode");
    const result = await execute(executor);

    expect(result.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const first = sessionOfCall(0);
    const second = sessionOfCall(1);
    expect(first).toMatch(OPENCODE_SESSION_RE);
    expect(second).toMatch(OPENCODE_SESSION_RE);
    expect(second).not.toBe(first);
  });

  it("returns the 429 when the retry is also rate limited, instead of looping", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, '{"error":{"type":"FreeUsageLimitError"}}'))
      .mockResolvedValueOnce(jsonResponse(429, '{"error":{"type":"FreeUsageLimitError"}}'));

    const executor = getExecutor("opencode");
    const result = await execute(executor);

    expect(result.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not rotate on a successful response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, "{}"));

    const executor = getExecutor("opencode");
    await execute(executor);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not rotate on a non-429 error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, '{"error":{"message":"bad request"}}'));

    const executor = getExecutor("opencode");
    const result = await execute(executor);

    expect(result.response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds rotation to one per identity per cooldown window", async () => {
    // A genuine account-wide limit must not mint a session per request — that is
    // the failure the stable-session store exists to prevent.
    fetchMock.mockResolvedValue(jsonResponse(429, '{"error":{"type":"FreeUsageLimitError"}}'));

    const executor = getExecutor("opencode");
    const credentials = makeCredentials();

    await execute(executor, { credentials });
    const callsAfterFirst = fetchMock.mock.calls.length;

    await execute(executor, { credentials });
    const callsAfterSecond = fetchMock.mock.calls.length;

    // First request: original + one rotated retry. Second request inside the
    // cooldown: a single attempt, no rotation.
    expect(callsAfterFirst).toBe(2);
    expect(callsAfterSecond - callsAfterFirst).toBe(1);
  });

  it("keeps a healthy conversation on one session across requests", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, "{}"));

    const executor = getExecutor("opencode");
    const credentials = makeCredentials();

    await execute(executor, { credentials });
    await execute(executor, { credentials });

    expect(sessionOfCall(0)).toBe(sessionOfCall(1));
  });
});
