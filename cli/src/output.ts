export type Writer = (s: string) => void;
export const EXIT = { OK: 0, GENERIC: 1, USAGE: 2, PAYMENT: 3, NOT_FOUND: 4 } as const;
export function printJson(w: Writer, value: unknown): void {
  w(`${JSON.stringify(value, null, 2)}\n`);
}
export function printError(w: Writer, code: string, message: string, hint?: string): void {
  w(`${JSON.stringify({ error: message, code, ...(hint ? { hint } : {}) })}\n`);
}
