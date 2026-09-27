import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_VARS = ["CF_ACCOUNT_ID", "CF_API_TOKEN", "CF_KV_NAMESPACE_ID"];
const fetchMock = vi.fn();

const { getKvValue, putKvValue } = await import("../../src/lib/kv.js");

describe("Cloudflare KV client", () => {
  beforeEach(() => {
    process.env.CF_ACCOUNT_ID = "acct-1";
    process.env.CF_API_TOKEN = "token-1";
    process.env.CF_KV_NAMESPACE_ID = "ns-1";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const name of ENV_VARS) delete process.env[name];
  });

  it("getKvValue() GETs the right URL with a Bearer token and returns the body text", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '{"hello":"world"}' });

    const result = await getKvValue("index");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/acct-1/storage/kv/namespaces/ns-1/values/index",
      { headers: { Authorization: "Bearer token-1" } },
    );
    expect(result).toBe('{"hello":"world"}');
  });

  it("getKvValue() returns undefined on a 404 instead of throwing", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => "not found" });
    expect(await getKvValue("missing")).toBeUndefined();
  });

  it("getKvValue() throws on other errors", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
    await expect(getKvValue("index")).rejects.toThrow("HTTP 500");
  });

  it("putKvValue() PUTs the value with a Bearer token", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });

    await putKvValue("index", '{"a":1}');

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/acct-1/storage/kv/namespaces/ns-1/values/index",
      {
        method: "PUT",
        headers: { Authorization: "Bearer token-1", "Content-Type": "text/plain" },
        body: '{"a":1}',
      },
    );
  });

  it("URL-encodes special characters in the key", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    await getKvValue("run:abc/def");
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/values/run%3Aabc%2Fdef");
  });

  it("throws a clear error when credentials are missing, without ever calling fetch", async () => {
    delete process.env.CF_API_TOKEN;
    await expect(getKvValue("index")).rejects.toThrow("Missing env var CF_API_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
