import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/storage.js", () => ({
  listRunIds: vi.fn(),
  downloadRunArtifact: vi.fn(),
  uploadRunArtifact: vi.fn(async () => {}),
}));

const { listRunIds, downloadRunArtifact, uploadRunArtifact } = await import("../../src/lib/storage.js");
const { rebuildGalleryIndex } = await import("../../src/lib/gallery.js");

function metaBytes(meta: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(meta));
}

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
