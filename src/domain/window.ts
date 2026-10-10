export interface SyncWindow {
  since: Date;
  until: Date;
}

export const MAX_WINDOW_DAYS = 90;

export type WindowResult = { ok: true; window: SyncWindow } | { ok: false; message: string };

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Janela meio aberta [since, until) sobre a data de publicação do post. */
export function parseSyncWindow(input: unknown): WindowResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, message: "corpo deve ser um objeto com since e until" };
  }
  const { since, until } = input as Record<string, unknown>;
  if (typeof since !== "string" || !ISO_INSTANT.test(since)) {
    return { ok: false, message: "since deve ser uma data ISO 8601 com fuso (ex.: 2026-09-01T00:00:00Z)" };
  }
  if (typeof until !== "string" || !ISO_INSTANT.test(until)) {
    return { ok: false, message: "until deve ser uma data ISO 8601 com fuso (ex.: 2026-09-08T00:00:00Z)" };
  }
  const s = new Date(since);
  const u = new Date(until);
  if (Number.isNaN(s.getTime()) || Number.isNaN(u.getTime())) {
    return { ok: false, message: "since ou until não é uma data válida" };
  }
  if (s.getTime() >= u.getTime()) {
    return { ok: false, message: "since precisa ser anterior a until" };
  }
  if (u.getTime() - s.getTime() > MAX_WINDOW_DAYS * 24 * 3600 * 1000) {
    return { ok: false, message: `a janela pode ter no máximo ${MAX_WINDOW_DAYS} dias` };
  }
  return { ok: true, window: { since: s, until: u } };
}
