import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];

const sendMock = vi.fn(async () => ({}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation((config: unknown) => ({ config, send: sendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const getSignedUrlMock = vi.fn(async () => "https://signed.example/run.mp4");
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: getSignedUrlMock }));

const { S3Client, PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
const { uploadRunArtifact, getRunArtifactUrl } = await import("../../src/lib/storage.js");

describe("storage (R2 via the S3 API)", () => {
  beforeEach(() => {
    process.env.R2_ACCOUNT_ID = "acct-1";
    process.env.R2_ACCESS_KEY_ID = "key-1";
    process.env.R2_SECRET_ACCESS_KEY = "secret-1";
    process.env.R2_BUCKET = "runs-bucket";
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
    delete process.env.R2_ACCOUNT_ID;
    await expect(uploadRunArtifact("k", new Uint8Array(), "text/plain")).rejects.toThrow("Missing env var R2_ACCOUNT_ID");
  });
});
