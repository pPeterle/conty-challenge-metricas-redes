import { describe, expect, it } from "vitest";
import { parsePage } from "../../src/provider/http-client.ts";

const item = {
  id: "p1",
  published_at: "2026-09-01T00:00:00Z",
  caption: "oi",
  captured_at: "2026-10-01T10:00:00Z",
  metrics: { views: 10, likes: 2, comments: 0 },
};

describe("parsePage", () => {
  it("normaliza datas para ISO UTC com milissegundos (a chave do snapshot fica estável)", () => {
    const page = parsePage({ data: [item, { ...item, captured_at: "2026-10-01T07:00:00.000-03:00" }], next_cursor: null });
    expect(page?.posts.map((p) => p.capturedAt)).toEqual(["2026-10-01T10:00:00.000Z", "2026-10-01T10:00:00.000Z"]);
  });

  it("recusa resposta fora do contrato", () => {
    expect(parsePage({ data: [{ ...item, metrics: { views: -1, likes: 0, comments: 0 } }] })).toBeNull();
    expect(parsePage({ data: [{ ...item, captured_at: "ontem" }] })).toBeNull();
    expect(parsePage({ data: [{ ...item, metrics: { views: 1.5, likes: 0, comments: 0 } }] })).toBeNull();
    expect(parsePage({ items: [] })).toBeNull();
  });

  it.each(["2026-10-01T10:00:00", "1", "-5", "Oct 1", "2026-02-30T00:00:00Z"])("captured_at %s (sem fuso ou inválido) é recusado", (captured_at) => {
    expect(parsePage({ data: [{ ...item, captured_at }], next_cursor: null })).toBeNull();
  });

  it("métrica acima de Number.MAX_SAFE_INTEGER e página gigante são recusadas", () => {
    expect(parsePage({ data: [{ ...item, metrics: { views: 2 ** 60, likes: 0, comments: 0 } }] })).toBeNull();
    expect(parsePage({ data: Array(1_001).fill(item) })).toBeNull();
  });
});
