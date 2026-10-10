import { describe, expect, it } from "vitest";
import { parseSyncWindow } from "../../src/domain/window.ts";

describe("parseSyncWindow", () => {
  it("aceita janela ISO com fuso", () => {
    const r = parseSyncWindow({ since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00-03:00" });
    expect(r).toEqual({
      ok: true,
      window: { since: new Date("2026-09-01T00:00:00Z"), until: new Date("2026-09-02T03:00:00Z") },
    });
  });

  it("recusa data sem fuso, janela invertida e janela grande demais", () => {
    expect(parseSyncWindow({ since: "2026-09-01T00:00:00", until: "2026-09-02T00:00:00Z" }).ok).toBe(false);
    expect(parseSyncWindow({ since: "2026-09-02T00:00:00Z", until: "2026-09-01T00:00:00Z" }).ok).toBe(false);
    expect(parseSyncWindow({ since: "2026-09-01T00:00:00Z", until: "2026-09-01T00:00:00Z" }).ok).toBe(false);
    expect(parseSyncWindow({ since: "2026-01-01T00:00:00Z", until: "2026-12-01T00:00:00Z" }).ok).toBe(false);
    expect(parseSyncWindow(null).ok).toBe(false);
  });
});
