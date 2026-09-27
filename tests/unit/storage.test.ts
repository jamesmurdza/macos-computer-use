import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_VARS = ["CF_ACCOUNT_ID", "CF_ACCESS_KEY_ID", "CF_SECRET_ACCESS_KEY", "CF_BUCKET"];

const sendMock = vi.fn(async () => ({}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation((config: unknown) => ({ config, send: sendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const getSignedUrlMock = vi.fn(async () => "https://signed.example/run.mp4");
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: getSignedUrlMock }));

const { S3Client, PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
const { uploadRunArtifact, getRunArtifactUrl, publicRunArtifactUrl } = await import("../../src/lib/storage.js");

describe("storage (R2 via the S3 API)", () => {
  beforeEach(() => {
    process.env.CF_ACCOUNT_ID = "acct-1";
    process.env.CF_ACCESS_KEY_ID = "key-1";
    process.env.CF_SECRET_ACCESS_KEY = "secret-1";
    process.env.CF_BUCKET = "runs-bucket";
    sendMock.mockClear();
    getSignedUrlMock.mockClear();
    vi.mocked(S3Client).mockClear();
    vi.mocked(PutObjectCommand).mockClear();
    vi.mocked(GetObjectCommand).mockClear();
  });

  afterEach(() => {
    for (const name of ENV_VARS) delete process.env[name];
  });

  it("uploadRunArtifact() PUTs to the R2 endpoint derived from the account id", async () => {
    const body = new Uint8Array([1, 2, 3]);
    await uploadRunArtifact("runs/abc/video.mp4", body, "video/mp4");

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "auto",
        endpoint: "https://acct-1.r2.cloudflarestorage.com",
        credentials: { accessKeyId: "key-1", secretAccessKey: "secret-1" },
      }),
    );
    expect(PutObjectCommand).toHaveBeenCalledWith({
      Bucket: "runs-bucket",
      Key: "runs/abc/video.mp4",
      Body: body,
      ContentType: "video/mp4",
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("getRunArtifactUrl() presigns a GET for the given key", async () => {
    const url = await getRunArtifactUrl("runs/abc/events.jsonl");
    expect(url).toBe("https://signed.example/run.mp4");
    expect(GetObjectCommand).toHaveBeenCalledWith({ Bucket: "runs-bucket", Key: "runs/abc/events.jsonl" });
    expect(getSignedUrlMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), { expiresIn: 7 * 24 * 60 * 60 });
  });

  it("throws a clear error when R2 credentials are missing, without ever calling the SDK", async () => {
    delete process.env.CF_ACCOUNT_ID;
    await expect(uploadRunArtifact("k", new Uint8Array(), "text/plain")).rejects.toThrow("Missing env var CF_ACCOUNT_ID");
  });
});

describe("publicRunArtifactUrl", () => {
  afterEach(() => {
    delete process.env.CF_PUBLIC_BASE_URL;
  });

  it("joins the configured public base URL and key, no network call", () => {
    process.env.CF_PUBLIC_BASE_URL = "https://pub-abc123.r2.dev";
    expect(publicRunArtifactUrl("runs/xyz/video.mp4")).toBe("https://pub-abc123.r2.dev/runs/xyz/video.mp4");
  });

  it("strips a trailing slash from the base URL", () => {
    process.env.CF_PUBLIC_BASE_URL = "https://pub-abc123.r2.dev/";
    expect(publicRunArtifactUrl("runs/xyz/video.mp4")).toBe("https://pub-abc123.r2.dev/runs/xyz/video.mp4");
  });

  it("returns undefined when not configured, so callers fall back to a presigned URL", () => {
    expect(publicRunArtifactUrl("runs/xyz/video.mp4")).toBeUndefined();
  });
});
