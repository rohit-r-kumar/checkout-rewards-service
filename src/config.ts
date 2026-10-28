import 'dotenv/config';

const toInt = (value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? String(fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: toInt(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'file:./prisma/dev.db',
  couponMilestone: toInt(process.env.COUPON_N, 5),
  couponPercent: toInt(process.env.COUPON_X, 10),
};
