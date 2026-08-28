const t = () => new Date().toISOString().slice(11, 23);

export const log = {
  info:  (m: string, ...a: unknown[]) => console.log(`[${t()}] ${m}`, ...a),
  warn:  (m: string, ...a: unknown[]) => console.warn(`[${t()}] ⚠ ${m}`, ...a),
  error: (m: string, ...a: unknown[]) => console.error(`[${t()}] ✗ ${m}`, ...a),
  ok:    (m: string, ...a: unknown[]) => console.log(`[${t()}] ✓ ${m}`, ...a),
};
