import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/storage.js", () => ({
  listRunIds: vi.fn(),
  downloadRunArtifact: vi.fn(),
}));
vi.mock("../../src/lib/kv.js", () => ({
  getKvValue: vi.fn(),
  putKvValue: vi.fn(async () => {}),
}));

const { listRunIds, downloadRunArtifact } = await import("../../src/lib/storage.js");
const { getKvValue, putKvValue } = await import("../../src/lib/kv.js");
const { rebuildGalleryIndex, addRunToGalleryIndex } = await import("../../src/lib/gallery.js");

function metaBytes(meta: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(meta));
}

const OLD_OK_META = {
  runId: "run-old-ok",
  prompt: "open safari and go to example.com",
  videoStartedAt: 1000,
  videoEndedAt: 5000,
  videoFile: "video.mp4",
  status: "ok" as const,
};
const NEW_OK_META = {
  runId: "run-new-ok",
  prompt: "open TextEdit and type Hello World",
  videoStartedAt: 2_000_000,
  videoEndedAt: 2_010_000,
  videoFile: "video.mp4",
  status: "ok" as const,
};

describe("rebuildGalleryIndex (repair/backfill: scans R2, writes the whole index to KV)", () => {
  beforeEach(() => {
    vi.mocked(listRunIds).mockReset();
    vi.mocked(downloadRunArtifact).mockReset();
    vi.mocked(putKvValue).mockClear();
  });

  it("includes only status:ok runs with a video, newest first, and writes the KV index", async () => {
    vi.mocked(listRunIds).mockResolvedValue(["run-old-ok", "run-failed", "run-new-ok", "run-corrupt"]);
    vi.mocked(downloadRunArtifact).mockImplementation(async (key: string) => {
      if (key === "runs/run-old-ok/meta.json") return metaBytes(OLD_OK_META);
      if (key === "runs/run-failed/meta.json") return metaBytes({ runId: "run-failed", prompt: "do something", status: "error" });
      if (key === "runs/run-new-ok/meta.json") return metaBytes(NEW_OK_META);
      if (key === "runs/run-corrupt/meta.json") return new TextEncoder().encode("{not json");
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
    expect(putKvValue).toHaveBeenCalledWith("index", JSON.stringify(entries));
  });

  it("skips a run whose meta.json is missing entirely", async () => {
    vi.mocked(listRunIds).mockResolvedValue(["run-gone"]);
    vi.mocked(downloadRunArtifact).mockResolvedValue(undefined);

    const entries = await rebuildGalleryIndex();
    expect(entries).toEqual([]);
  });
});

describe("addRunToGalleryIndex (normal per-run path: one KV read + one KV write)", () => {
  beforeEach(() => {
    vi.mocked(getKvValue).mockReset();
    vi.mocked(putKvValue).mockClear();
  });

  it("appends to an empty/missing index", async () => {
    vi.mocked(getKvValue).mockResolvedValue(undefined);

    const entries = await addRunToGalleryIndex("run-new-ok", NEW_OK_META);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ runId: "run-new-ok", videoKey: "runs/run-new-ok/video.mp4" });
    expect(putKvValue).toHaveBeenCalledWith("index", JSON.stringify(entries));
  });

  it("prepends a new run ahead of an existing older one (newest first)", async () => {
    const existing = [
      {
        runId: "run-old-ok",
        description: "open safari and go to example.com",
        date: new Date(1000).toISOString(),
        durationMs: 4000,
        videoKey: "runs/run-old-ok/video.mp4",
        thumbnailKey: "runs/run-old-ok/thumbnail.jpg",
      },
    ];
    vi.mocked(getKvValue).mockResolvedValue(JSON.stringify(existing));

    const entries = await addRunToGalleryIndex("run-new-ok", NEW_OK_META);

    expect(entries.map((e) => e.runId)).toEqual(["run-new-ok", "run-old-ok"]);
  });

  it("replaces an existing entry for the same runId instead of duplicating it", async () => {
    const existing = [
      {
        runId: "run-new-ok",
        description: "stale description",
        date: new Date(1).toISOString(),
        durationMs: 1,
        videoKey: "runs/run-new-ok/old-video.mp4",
        thumbnailKey: "runs/run-new-ok/thumbnail.jpg",
      },
    ];
    vi.mocked(getKvValue).mockResolvedValue(JSON.stringify(existing));

    const entries = await addRunToGalleryIndex("run-new-ok", NEW_OK_META);

    expect(entries).toHaveLength(1);
    expect(entries[0].description).toBe("open TextEdit and type Hello World");
  });

  it("does not add a failed run, and leaves the index untouched", async () => {
    vi.mocked(getKvValue).mockResolvedValue(undefined);

    const entries = await addRunToGalleryIndex("run-failed", { runId: "run-failed", prompt: "do something", status: "error" });

    expect(entries).toEqual([]);
    expect(putKvValue).not.toHaveBeenCalled();
  });

  it("treats a corrupt existing KV value as an empty index rather than throwing", async () => {
    vi.mocked(getKvValue).mockResolvedValue("{not json");

    const entries = await addRunToGalleryIndex("run-new-ok", NEW_OK_META);
    expect(entries).toHaveLength(1);
  });
});
