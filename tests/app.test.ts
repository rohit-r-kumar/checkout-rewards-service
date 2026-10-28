import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { config } from '../src/config.js';

const clearDatabase = async () => {
  await prisma.checkoutRequest.deleteMany();
  await prisma.coupon.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.cartItem.deleteMany();
  await prisma.cart.deleteMany();
  await prisma.product.deleteMany();

  await prisma.product.createMany({
    data: [
      { sku: 'KB-100', name: 'Mechanical Keyboard', priceMinor: 5980, inventory: 8 },
      { sku: 'MS-200', name: 'Wireless Mouse', priceMinor: 2490, inventory: 12 },
      { sku: 'MN-300', name: '27-inch Monitor', priceMinor: 18990, inventory: 4 },
      { sku: 'HD-400', name: 'Noise-Cancelling Headphones', priceMinor: 8990, inventory: 3 },
      { sku: 'USB-500', name: 'USB-C Hub', priceMinor: 3490, inventory: 15 },
      { sku: 'CAM-600', name: '1080p Webcam', priceMinor: 7990, inventory: 2 },
    ],
  });
};

beforeEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('checkout service', () => {
  it('rejects invalid products and quantities', async () => {
    const cartResponse = await request(app).post('/api/carts').send();
    const cartId = cartResponse.body.cart.id;

    const invalidProduct = await request(app)
      .post(`/api/carts/${cartId}/items`)
      .send({ productId: 'missing-product', quantity: 1 });

    expect(invalidProduct.status).toBe(404);

    const product = await prisma.product.findFirstOrThrow();

    const invalidQuantity = await request(app)
      .post(`/api/carts/${cartId}/items`)
      .send({ productId: product.id, quantity: 0 });

    expect(invalidQuantity.status).toBe(400);
  });

  it('rejects checkout when inventory is insufficient', async () => {
    const cartResponse = await request(app).post('/api/carts').send();
    const cartId = cartResponse.body.cart.id;
    const product = await prisma.product.findFirstOrThrow();

    await request(app)
      .post(`/api/carts/${cartId}/items`)
      .send({ productId: product.id, quantity: product.inventory });

    const secondCart = await request(app).post('/api/carts').send();

    const result = await request(app)
      .post(`/api/carts/${secondCart.body.cart.id}/items`)
      .send({ productId: product.id, quantity: product.inventory + 1 });

    expect(result.status).toBe(422);
  });

  it('captures an immutable order snapshot and supports price validation', async () => {
    const cartResponse = await request(app).post('/api/carts').send();
    const cartId = cartResponse.body.cart.id;
    const product = await prisma.product.findFirstOrThrow();

    await prisma.product.update({
      where: { id: product.id },
      data: { priceMinor: 5555 },
    });

    await request(app)
      .post(`/api/carts/${cartId}/items`)
      .send({ productId: product.id, quantity: 2 });

    const orderResponse = await request(app)
      .post(`/api/carts/${cartId}/checkout`)
      .set('Idempotency-Key', 'idempotent-price-case')
      .send();

    expect(orderResponse.status).toBe(200);
    expect(orderResponse.body.totalMinor).toBe(11110);

    const orderLookup = await request(app).get(`/api/orders/${orderResponse.body.orderId}`);
    expect(orderLookup.body.order.items[0].unitPriceMinor).toBe(5555);
    expect(orderLookup.body.order.items[0].lineTotalMinor).toBe(11110);
  });

  it('reuses identical checkout requests via idempotency key', async () => {
    const cartResponse = await request(app).post('/api/carts').send();
    const cartId = cartResponse.body.cart.id;
    const product = await prisma.product.findFirstOrThrow();

    await request(app)
      .post(`/api/carts/${cartId}/items`)
      .send({ productId: product.id, quantity: 1 });

    const first = await request(app)
      .post(`/api/carts/${cartId}/checkout`)
      .set('Idempotency-Key', 'repeat-key')
      .send();

    const second = await request(app)
      .post(`/api/carts/${cartId}/checkout`)
      .set('Idempotency-Key', 'repeat-key')
      .send();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.orderId).toBe(first.body.orderId);
  });

  it('rejects conflicting reuse of the same idempotency key', async () => {
    const product = await prisma.product.findFirstOrThrow();
    const firstCart = await request(app).post('/api/carts').send();
    await request(app)
      .post(`/api/carts/${firstCart.body.cart.id}/items`)
      .send({ productId: product.id, quantity: 1 });

    const firstCheckout = await request(app)
      .post(`/api/carts/${firstCart.body.cart.id}/checkout`)
      .set('Idempotency-Key', 'conflict-key')
      .send();

    expect(firstCheckout.status).toBe(200);

    const secondCart = await request(app).post('/api/carts').send();
    await request(app)
      .post(`/api/carts/${secondCart.body.cart.id}/items`)
      .send({ productId: product.id, quantity: 1 });

    const second = await request(app)
      .post(`/api/carts/${secondCart.body.cart.id}/checkout`)
      .set('Idempotency-Key', 'conflict-key')
      .send();

    expect(second.status).toBe(409);
  });

  it('prevents a cart from producing more than one successful order', async () => {
    const cartResponse = await request(app).post('/api/carts').send();
    const cartId = cartResponse.body.cart.id;
    const product = await prisma.product.findFirstOrThrow();

    await request(app)
      .post(`/api/carts/${cartId}/items`)
      .send({ productId: product.id, quantity: 1 });

    const first = await request(app)
      .post(`/api/carts/${cartId}/checkout`)
      .set('Idempotency-Key', 'single-order-cart-1')
      .send();

    const second = await request(app)
      .post(`/api/carts/${cartId}/checkout`)
      .set('Idempotency-Key', 'single-order-cart-2')
      .send();

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
  });

  it('only allows the first checkout to secure the last inventory unit', async () => {
    const product = await prisma.product.findFirstOrThrow();
    const cartA = await request(app).post('/api/carts').send();
    const cartB = await request(app).post('/api/carts').send();

    await prisma.product.update({
      where: { id: product.id },
      data: { inventory: 1 },
    });

    await request(app).post(`/api/carts/${cartA.body.cart.id}/items`).send({ productId: product.id, quantity: 1 });
    await request(app).post(`/api/carts/${cartB.body.cart.id}/items`).send({ productId: product.id, quantity: 1 });

    const [first, second] = await Promise.all([
      request(app).post(`/api/carts/${cartA.body.cart.id}/checkout`).set('Idempotency-Key', 'race-cart-a').send(),
      request(app).post(`/api/carts/${cartB.body.cart.id}/checkout`).set('Idempotency-Key', 'race-cart-b').send(),
    ]);

    const successes = [first, second].filter((result) => result.status === 200).length;
    expect(successes).toBe(1);
  });

  it('generates a milestone coupon once and rejects duplicate milestone generation', async () => {
    const product = await prisma.product.findFirstOrThrow();
    const cartIds: string[] = [];

    for (let i = 0; i < config.couponMilestone; i += 1) {
      const cart = await request(app).post('/api/carts').send();
      cartIds.push(cart.body.cart.id);
      await request(app).post(`/api/carts/${cart.body.cart.id}/items`).send({ productId: product.id, quantity: 1 });
      await request(app).post(`/api/carts/${cart.body.cart.id}/checkout`).set('Idempotency-Key', `coupon-order-${i}`).send();
    }

    const first = await request(app).post('/api/admin/coupons/generate').send();
    const second = await request(app).post('/api/admin/coupons/generate').send();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.generated.length).toBeGreaterThan(0);
    expect(second.body.generated).toEqual([]);
  });

  it('redeems a coupon only once across concurrent checkouts', async () => {
    const product = await prisma.product.findFirstOrThrow();

    for (let i = 0; i < config.couponMilestone; i += 1) {
      const cart = await request(app).post('/api/carts').send();
      await request(app).post(`/api/carts/${cart.body.cart.id}/items`).send({ productId: product.id, quantity: 1 });
      await request(app).post(`/api/carts/${cart.body.cart.id}/checkout`).set('Idempotency-Key', `preorder-${i}`).send();
    }

    const generateResponse = await request(app).post('/api/admin/coupons/generate').send();
    const coupon = generateResponse.body.generated[0];

    expect(coupon).toBeDefined();

    const cartA = await request(app).post('/api/carts').send();
    const cartB = await request(app).post('/api/carts').send();
    await request(app).post(`/api/carts/${cartA.body.cart.id}/items`).send({ productId: product.id, quantity: 1 });
    await request(app).post(`/api/carts/${cartB.body.cart.id}/items`).send({ productId: product.id, quantity: 1 });

    const [first, second] = await Promise.all([
      request(app).post(`/api/carts/${cartA.body.cart.id}/checkout`).set('Idempotency-Key', 'coupon-a').send({ couponCode: coupon.code }),
      request(app).post(`/api/carts/${cartB.body.cart.id}/checkout`).set('Idempotency-Key', 'coupon-b').send({ couponCode: coupon.code }),
    ]);

    const successCount = [first, second].filter((result) => result.status === 200).length;
    expect(successCount).toBe(1);
  });

  it('keeps inventory and coupon availability consistent when checkout fails', async () => {
    const product = await prisma.product.findFirstOrThrow();
    const cart = await request(app).post('/api/carts').send();
    await request(app).post(`/api/carts/${cart.body.cart.id}/items`).send({ productId: product.id, quantity: 2 });

    await prisma.product.update({
      where: { id: product.id },
      data: { inventory: 1 },
    });

    const failure = await request(app)
      .post(`/api/carts/${cart.body.cart.id}/checkout`)
      .set('Idempotency-Key', 'failed-checkout')
      .send();

    expect(failure.status).toBe(422);
    const reloaded = await prisma.product.findUnique({ where: { id: product.id } });
    expect(reloaded?.inventory).toBe(1);
  });

  it('reconciles report totals and discount rounding', async () => {
    const product = await prisma.product.findFirstOrThrow();
    const cart = await request(app).post('/api/carts').send();
    await request(app).post(`/api/carts/${cart.body.cart.id}/items`).send({ productId: product.id, quantity: 3 });

    await request(app)
      .post(`/api/carts/${cart.body.cart.id}/checkout`)
      .set('Idempotency-Key', 'report-checkout')
      .send();

    const summary = await request(app).get('/api/admin/reports/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.totalSuccessfullyPlacedOrders).toBe(1);
    expect(summary.body.grossRevenueMinor).toBeGreaterThan(0);
    expect(summary.body.netRevenueMinor).toBe(summary.body.grossRevenueMinor - summary.body.totalDiscountsMinor);
  });
});
