import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/storage.js", () => ({
  listRunIds: vi.fn(),
  downloadRunArtifact: vi.fn(),
  uploadRunArtifact: vi.fn(async () => {}),
  publicRunArtifactUrl: vi.fn((key: string) => {
    const base = process.env.R2_PUBLIC_BASE_URL;
    return base ? `${base}/${key}` : undefined;
  }),
}));

const { listRunIds, downloadRunArtifact, uploadRunArtifact } = await import("../../src/lib/storage.js");
const { rebuildGalleryIndex, loadGalleryIndex, formatDuration } = await import("../../src/lib/gallery.js");

function metaBytes(meta: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(meta));
}

describe("formatDuration", () => {
  it("formats under an hour as m:ss with no leading zero on minutes", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(5_000)).toBe("0:05");
    expect(formatDuration(271_000)).toBe("4:31");
    expect(formatDuration(599_000)).toBe("9:59");
  });

  it("formats an hour or more as h:mm:ss with zero-padded minutes", () => {
    expect(formatDuration(3_871_000)).toBe("1:04:31");
    expect(formatDuration(3_600_000)).toBe("1:00:00");
  });

  it("rounds to the nearest second", () => {
    expect(formatDuration(4_700)).toBe("0:05");
    expect(formatDuration(4_400)).toBe("0:04");
  });
});

describe("rebuildGalleryIndex", () => {
  beforeEach(() => {
    vi.mocked(listRunIds).mockReset();
    vi.mocked(downloadRunArtifact).mockReset();
    vi.mocked(uploadRunArtifact).mockClear();
  });

  it("includes only status:ok runs with a video, newest first, and uploads index.json", async () => {
    vi.mocked(listRunIds).mockResolvedValue(["run-old-ok", "run-failed", "run-new-ok", "run-corrupt"]);
    vi.mocked(downloadRunArtifact).mockImplementation(async (key: string) => {
      if (key === "runs/run-old-ok/meta.json") {
        return metaBytes({
          runId: "run-old-ok",
          prompt: "open safari and go to example.com",
          videoStartedAt: 1000,
          videoEndedAt: 5000,
          videoFile: "video.mp4",
          status: "ok",
        });
      }
      if (key === "runs/run-failed/meta.json") {
        return metaBytes({ runId: "run-failed", prompt: "do something", status: "error" });
      }
      if (key === "runs/run-new-ok/meta.json") {
        return metaBytes({
          runId: "run-new-ok",
          prompt: "open TextEdit and type Hello World",
          videoStartedAt: 2_000_000,
          videoEndedAt: 2_010_000,
          videoFile: "video.mp4",
          status: "ok",
        });
      }
      if (key === "runs/run-corrupt/meta.json") {
        return new TextEncoder().encode("{not json");
      }
      return undefined;
    });

    const entries = await rebuildGalleryIndex();

    expect(entries.map((e) => e.runId)).toEqual(["run-new-ok", "run-old-ok"]);
    expect(entries[0]).toMatchObject({
      description: "open TextEdit and type Hello World",
      durationMs: 10_000,
      videoKey: "runs/run-new-ok/video.mp4",
      thumbnailKey: "runs/run-new-ok/thumbnail.jpg",
    });
    expect(uploadRunArtifact).toHaveBeenCalledWith("index.json", expect.any(Uint8Array), "application/json");
  });

  it("skips a run whose meta.json is missing entirely", async () => {
    vi.mocked(listRunIds).mockResolvedValue(["run-gone"]);
    vi.mocked(downloadRunArtifact).mockResolvedValue(undefined);

    const entries = await rebuildGalleryIndex();
    expect(entries).toEqual([]);
  });
});

describe("loadGalleryIndex", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.R2_PUBLIC_BASE_URL;
  });

  it("reports not configured, and never calls fetch, when R2_PUBLIC_BASE_URL is unset", async () => {
    const result = await loadGalleryIndex();
    expect(result).toEqual({ configured: false, entries: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves each entry's keys to public URLs", async () => {
    process.env.R2_PUBLIC_BASE_URL = "https://pub-abc.r2.dev";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          runId: "r1",
          description: "open Safari and load the New York Times",
          date: "2026-09-27T00:00:00.000Z",
          durationMs: 271_000,
          videoKey: "runs/r1/video.mp4",
          thumbnailKey: "runs/r1/thumbnail.jpg",
        },
      ],
    });

    const result = await loadGalleryIndex();
    expect(result.configured).toBe(true);
    expect(result.entries).toEqual([
      expect.objectContaining({
        runId: "r1",
        videoUrl: "https://pub-abc.r2.dev/runs/r1/video.mp4",
        thumbnailUrl: "https://pub-abc.r2.dev/runs/r1/thumbnail.jpg",
      }),
    ]);
  });

  it("treats a 404 (no index.json yet) as zero entries, not an error", async () => {
    process.env.R2_PUBLIC_BASE_URL = "https://pub-abc.r2.dev";
    fetchMock.mockResolvedValue({ ok: false, status: 404 });

    const result = await loadGalleryIndex();
    expect(result).toEqual({ configured: true, entries: [] });
  });
});
