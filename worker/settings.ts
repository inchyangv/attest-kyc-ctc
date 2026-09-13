export function integerSetting(name: string, raw: string | undefined, fallback: number, min = 0): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be a safe integer >= ${min}`);
  return value;
}
