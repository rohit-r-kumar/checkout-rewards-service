import crypto from 'node:crypto';

export const stableHash = (value: unknown) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const moneyDiscount = (subtotalMinor: number, percent: number) => {
  const raw = Math.floor((subtotalMinor * percent) / 100);
  return Math.min(raw, subtotalMinor);
};

export const toErrorResponse = (error: { statusCode?: number; code?: string; message: string }) => ({
  error: {
    code: error.code ?? 'INTERNAL_ERROR',
    message: error.message,
  },
});
