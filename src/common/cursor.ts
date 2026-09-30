import { createHash } from "crypto";
import { AppError } from "./errors";

const CURSOR_VERSION = 1;

/** Where the previous page stopped: the sort key of its last row.
 * `sequence` pages one account by posting sequence; `time` pages merged sub-accounts by
 * (createdAt, _id). */
export type CursorPosition =
  | { mode: 'sequence'; sequence: number }
  | { mode: 'time'; createdAt: Date; id: string };

type Encoded =
  | { v: number; f: string; m: 's'; s: number }
  | { v: number; f: string; m: 't'; t: number; i: string };

export function cursorFingerprint(filters: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(filters)).digest('base64url').slice(0, 16);
}

export function encodeCursor(position: CursorPosition, fingerprint: string): string {
  const body: Encoded =
    position.mode === 'sequence'
      ? { v: CURSOR_VERSION, f: fingerprint, m: 's', s: position.sequence }
      : { v: CURSOR_VERSION, f: fingerprint, m: 't', t: position.createdAt.getTime(), i: position.id };
  return Buffer.from(JSON.stringify(body)).toString('base64url');
}

export function decodeCursor(raw: string, fingerprint: string): CursorPosition {
  let body: Record<string, unknown> | null;
  try {
    body = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!body || typeof body !== 'object' || body.v !== CURSOR_VERSION) throw invalid();
  if (body.f !== fingerprint) {
    throw AppError.validation('Cursor does not match the current filters; restart pagination without a cursor');
  }
  const { m, s, t, i } = body;
  if (m === 's' && Number.isSafeInteger(s)) {
    return { mode: 'sequence', sequence: s as number };
  }
  if (m === 't' && Number.isSafeInteger(t) && typeof i === 'string' && /^[0-9a-f]{24}$/i.test(i)) {
    return { mode: 'time', createdAt: new Date(t as number), id: i };
  }
  throw invalid();
}

function invalid(): AppError {
  return AppError.validation('Invalid cursor');
}
