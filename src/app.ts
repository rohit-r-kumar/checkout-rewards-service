import express from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from './errors.js';
import { config } from './config.js';
import { moneyDiscount, stableHash, toErrorResponse } from './utils.js';

export const app = express();

app.use(express.json());

const itemSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().positive(),
});

const updateItemSchema = z.object({
  quantity: z.number().int().positive(),
});

const checkoutSchema = z.object({
  couponCode: z.string().trim().optional(),
}).strict();

const idempotencyHeaderName = 'Idempotency-Key';

const getCartPayload = (cart: {
  id: string;
  status: string;
  items: Array<{
    id: string;
    quantity: number;
    product: {
      id: string;
      sku: string;
      name: string;
      priceMinor: number;
      active: boolean;
    };
  }>;
}) => {
  const items = cart.items.map((item) => {
    const price = item.product.priceMinor;
    return {
      id: item.id,
      productId: item.product.id,
      sku: item.product.sku,
      name: item.product.name,
      quantity: item.quantity,
      unitPriceMinor: price,
      lineTotalMinor: price * item.quantity,
    };
  });

  const subtotalMinor = items.reduce((sum, item) => sum + item.lineTotalMinor, 0);

  return {
    id: cart.id,
    status: cart.status,
    subtotalMinor,
    items,
  };
};

const ensureCartExists = async (cartId: string) => {
  const cart = await prisma.cart.findUnique({
    where: { id: cartId },
    include: { items: { include: { product: true } } },
  });

  if (!cart) {
    throw notFound('CART_NOT_FOUND', 'Cart not found.');
  }

  return cart;
};

const normalizeCouponCode = (couponCode?: string) => {
  if (!couponCode) {
    return undefined;
  }

  const trimmed = couponCode.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/api/products', async (_req, res) => {
  const products = await prisma.product.findMany({
    where: { active: true },
    orderBy: { name: 'asc' },
  });

  res.status(200).json({
    products: products.map(({ id, sku, name, priceMinor, inventory }) => ({
      id,
      sku,
      name,
      priceMinor,
      inventory,
    })),
  });
});

app.post('/api/carts', async (_req, res) => {
  const cart = await prisma.cart.create({
    data: {},
  });

  res.status(201).json({ cart: { id: cart.id, status: cart.status } });
});

app.get('/api/carts/:cartId', async (req, res) => {
  const cart = await ensureCartExists(req.params.cartId);
  res.status(200).json(getCartPayload(cart));
});

app.post('/api/carts/:cartId/items', async (req, res) => {
  const result = itemSchema.safeParse(req.body);
  if (!result.success) {
    throw badRequest('INVALID_CART_ITEM', 'Product ID and a positive integer quantity are required.');
  }

  const { productId, quantity } = result.data;
  const cartId = req.params.cartId;

  await ensureCartExists(cartId);

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || !product.active) {
    throw notFound('PRODUCT_NOT_FOUND', 'Product not found or not available.');
  }

  const currentCart = await prisma.cart.findUnique({
    where: { id: cartId },
    include: { items: { include: { product: true } } },
  });

  if (!currentCart) {
    throw notFound('CART_NOT_FOUND', 'Cart not found.');
  }

  if (currentCart.status === 'CHECKED_OUT') {
    throw conflict('CART_ALREADY_CHECKED_OUT', 'This cart has already been checked out.');
  }

  const existingItem = currentCart.items.find((item) => item.productId === productId);
  const newTotalQuantity = existingItem ? existingItem.quantity + quantity : quantity;

  if (newTotalQuantity > product.inventory) {
    throw unprocessable('INSUFFICIENT_INVENTORY', `Only ${product.inventory} unit(s) are currently available.`);
  }

  const item = await prisma.cartItem.upsert({
    where: {
      cartId_productId: {
        cartId,
        productId,
      },
    },
    update: { quantity: newTotalQuantity },
    create: {
      cartId,
      productId,
      quantity,
    },
  });

  const refreshed = await prisma.cart.findUnique({
    where: { id: cartId },
    include: { items: { include: { product: true } } },
  });

  res.status(201).json({
    itemId: item.id,
    cart: refreshed ? getCartPayload(refreshed) : null,
  });
});

app.patch('/api/carts/:cartId/items/:productId', async (req, res) => {
  const result = updateItemSchema.safeParse(req.body);
  if (!result.success) {
    throw badRequest('INVALID_UPDATE', 'Quantity must be a positive integer.');
  }

  const cartId = req.params.cartId;
  const productId = req.params.productId;
  const { quantity } = result.data;

  const cart = await ensureCartExists(cartId);
  if (cart.status === 'CHECKED_OUT') {
    throw conflict('CART_ALREADY_CHECKED_OUT', 'This cart has already been checked out.');
  }

  const item = cart.items.find((entry) => entry.productId === productId);
  if (!item) {
    throw notFound('CART_ITEM_NOT_FOUND', 'Cart item not found.');
  }

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || !product.active) {
    throw notFound('PRODUCT_NOT_FOUND', 'Product no longer exists or is inactive.');
  }

  if (quantity > product.inventory) {
    throw unprocessable('INSUFFICIENT_INVENTORY', `Only ${product.inventory} unit(s) are available for this product.`);
  }

  const updatedItem = await prisma.cartItem.update({
    where: { id: item.id },
    data: { quantity },
  });

  const refreshed = await prisma.cart.findUnique({
    where: { id: cartId },
    include: { items: { include: { product: true } } },
  });

  res.status(200).json({
    itemId: updatedItem.id,
    cart: refreshed ? getCartPayload(refreshed) : null,
  });
});

app.delete('/api/carts/:cartId/items/:productId', async (req, res) => {
  const cartId = req.params.cartId;
  const productId = req.params.productId;

  const cart = await ensureCartExists(cartId);
  if (cart.status === 'CHECKED_OUT') {
    throw conflict('CART_ALREADY_CHECKED_OUT', 'This cart has already been checked out.');
  }

  const item = cart.items.find((entry) => entry.productId === productId);
  if (!item) {
    throw notFound('CART_ITEM_NOT_FOUND', 'Cart item not found.');
  }

  await prisma.cartItem.delete({ where: { id: item.id } });

  const refreshed = await prisma.cart.findUnique({
    where: { id: cartId },
    include: { items: { include: { product: true } } },
  });

  res.status(200).json({
    deletedProductId: productId,
    cart: refreshed ? getCartPayload(refreshed) : null,
  });
});

const buildCheckoutResult = async (cartId: string, couponCode?: string) => {
  const cart = await prisma.cart.findUnique({
    where: { id: cartId },
    include: { items: { include: { product: true } } },
  });

  if (!cart) {
    throw notFound('CART_NOT_FOUND', 'Cart not found.');
  }

  if (cart.status === 'CHECKED_OUT') {
    throw conflict('CART_ALREADY_CHECKED_OUT', 'This cart has already been checked out.');
  }

  if (cart.items.length === 0) {
    throw unprocessable('EMPTY_CART', 'The cart is empty.');
  }

  const snapshot = [] as Array<{
    productId: string;
    productSku: string;
    productName: string;
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
  }>;

  let subtotalMinor = 0;

  for (const item of cart.items) {
    const product = item.product;

    if (!product.active) {
      throw unprocessable('INVALID_PRODUCT', `Product ${product.name} is not active.`);
    }

    if (item.quantity <= 0) {
      throw badRequest('INVALID_QUANTITY', 'Cart item quantity must be positive.');
    }

    if (item.quantity > product.inventory) {
      throw unprocessable('INSUFFICIENT_INVENTORY', `Only ${product.inventory} unit(s) of ${product.name} are available.`);
    }

    const lineTotalMinor = product.priceMinor * item.quantity;
    subtotalMinor += lineTotalMinor;
    snapshot.push({
      productId: product.id,
      productSku: product.sku,
      productName: product.name,
      unitPriceMinor: product.priceMinor,
      quantity: item.quantity,
      lineTotalMinor,
    });
  }

  let discountMinor = 0;
  let couponToApply: { code: string; discountPercent: number } | null = null;

  const normalizedCoupon = normalizeCouponCode(couponCode);
  if (normalizedCoupon) {
    const coupon = await prisma.coupon.findUnique({
      where: { code: normalizedCoupon },
    });

    if (!coupon || coupon.status !== 'AVAILABLE') {
      throw unprocessable('INVALID_COUPON', 'The supplied coupon is not available for redemption.');
    }

    couponToApply = { code: coupon.code, discountPercent: coupon.discountPercent };
    discountMinor = moneyDiscount(subtotalMinor, coupon.discountPercent);
  }

  const totalMinor = Math.max(subtotalMinor - discountMinor, 0);

  return {
    cart,
    snapshot,
    subtotalMinor,
    discountMinor,
    totalMinor,
    couponToApply,
  };
};

app.post('/api/carts/:cartId/checkout', async (req, res) => {
  const idempotencyKey = req.get(idempotencyHeaderName);
  if (!idempotencyKey || !idempotencyKey.trim()) {
    throw badRequest('MISSING_IDEMPOTENCY_KEY', 'The Idempotency-Key header is required.');
  }

  const parsed = checkoutSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw badRequest('INVALID_CHECKOUT', 'Checkout payload is invalid.');
  }

  const couponCode = normalizeCouponCode(parsed.data.couponCode);
  const requestHash = stableHash({ cartId: req.params.cartId, couponCode: couponCode ?? null });

  const existing = await prisma.checkoutRequest.findUnique({
    where: { requestKey: idempotencyKey },
  });

  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw conflict('IDEMPOTENCY_KEY_CONFLICT', 'This idempotency key has already been used for a different request.');
    }

    const priorPayload = JSON.parse(existing.responsePayload) as Record<string, unknown>;
    res.status(existing.responseStatus).json(priorPayload);
    return;
  }

  const { cart, snapshot, subtotalMinor, discountMinor, totalMinor, couponToApply } = await buildCheckoutResult(req.params.cartId, couponCode);

  const order = await prisma.$transaction(async (tx) => {
    const conflictCheck = await tx.checkoutRequest.findUnique({
      where: { requestKey: idempotencyKey },
    });

    if (conflictCheck) {
      if (conflictCheck.requestHash !== requestHash) {
        throw conflict('IDEMPOTENCY_KEY_CONFLICT', 'This idempotency key has already been used for a different request.');
      }

      const payload = JSON.parse(conflictCheck.responsePayload) as Record<string, unknown>;
      return payload;
    }
    const currentCart = await tx.cart.findUnique({
      where: { id: cart.id },
      include: { items: { include: { product: true } } },
    });

    if (!currentCart) {
      throw notFound('CART_NOT_FOUND', 'Cart not found.');
    }

    if (currentCart.status === 'CHECKED_OUT') {
      throw conflict('CART_ALREADY_CHECKED_OUT', 'This cart has already been checked out.');
    }

    for (const item of currentCart.items) {
      const updated = await tx.product.updateMany({
        where: {
          id: item.productId,
          inventory: { gte: item.quantity },
        },
        data: {
          inventory: { decrement: item.quantity },
        },
      });

      if (updated.count !== 1) {
        throw unprocessable('INSUFFICIENT_INVENTORY', `Inventory for ${item.product.name} could not be reserved.`);
      }
    }

    const createdOrder = await tx.order.create({
      data: {
        cartId: currentCart.id,
        subtotalMinor,
        discountMinor,
        totalMinor,
        couponCode: couponToApply?.code ?? null,
        status: 'PAID',
        items: {
          create: snapshot.map((entry) => ({
            productId: entry.productId,
            productSku: entry.productSku,
            productName: entry.productName,
            unitPriceMinor: entry.unitPriceMinor,
            quantity: entry.quantity,
            lineTotalMinor: entry.lineTotalMinor,
          })),
        },
      },
    });

    await tx.cart.update({
      where: { id: currentCart.id },
      data: { status: 'CHECKED_OUT' },
    });

    if (couponToApply) {
      const coupon = await tx.coupon.findUnique({ where: { code: couponToApply.code } });
      if (!coupon || coupon.status !== 'AVAILABLE') {
        throw unprocessable('INVALID_COUPON', 'The coupon was consumed before checkout completed.');
      }

      await tx.coupon.update({
        where: { code: coupon.code },
        data: {
          status: 'REDEEMED',
          redeemedAt: new Date(),
          redeemedOrderId: createdOrder.id,
        },
      });
    }

    const response = {
      orderId: createdOrder.id,
      cartId: currentCart.id,
      status: createdOrder.status,
      subtotalMinor,
      discountMinor,
      totalMinor,
      couponCode: couponToApply?.code ?? null,
    };

    try {
      await tx.checkoutRequest.create({
        data: {
          requestKey: idempotencyKey,
          cartId: currentCart.id,
          couponCode: couponToApply?.code ?? null,
          requestHash,
          responseStatus: 200,
          responsePayload: JSON.stringify(response),
        },
      });
    } catch (insertError) {
      const asPrismaError = insertError as Prisma.PrismaClientKnownRequestError;
      if (asPrismaError.code === 'P2002') {
        const prior = await tx.checkoutRequest.findUnique({
          where: { requestKey: idempotencyKey },
        });
        if (prior) {
          const payload = JSON.parse(prior.responsePayload) as Record<string, unknown>;
          return payload;
        }
      }
      throw insertError;
    }

    return response;
  });

  res.status(200).json(order);
});

app.get('/api/orders/:orderId', async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.orderId },
    include: { items: true },
  });

  if (!order) {
    throw notFound('ORDER_NOT_FOUND', 'Order not found.');
  }

  res.status(200).json({
    order: {
      id: order.id,
      cartId: order.cartId,
      subtotalMinor: order.subtotalMinor,
      discountMinor: order.discountMinor,
      totalMinor: order.totalMinor,
      couponCode: order.couponCode,
      status: order.status,
      createdAt: order.createdAt,
      items: order.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        productSku: item.productSku,
        productName: item.productName,
        unitPriceMinor: item.unitPriceMinor,
        quantity: item.quantity,
        lineTotalMinor: item.lineTotalMinor,
      })),
    },
  });
});

app.post('/api/admin/coupons/generate', async (_req, res) => {
  const successfulOrders = await prisma.order.count();
  const existingMilestones = await prisma.coupon.findMany({
    select: { milestone: true },
  });
  const generatedMilestones = new Set(existingMilestones.map((row) => row.milestone));
  const eligibleMilestones: number[] = [];

  for (let milestone = config.couponMilestone; milestone <= successfulOrders; milestone += config.couponMilestone) {
    if (!generatedMilestones.has(milestone)) {
      eligibleMilestones.push(milestone);
    }
  }

  if (eligibleMilestones.length === 0) {
    res.status(200).json({ generated: [], message: 'No eligible milestones to reward.' });
    return;
  }

  const generated = [] as Array<{ code: string; milestone: number; discountPercent: number; status: string }>;

  for (const milestone of eligibleMilestones) {
    try {
      const coupon = await prisma.coupon.create({
        data: {
          code: `SAVE-${milestone}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
          milestone,
          discountPercent: config.couponPercent,
          status: 'AVAILABLE',
        },
      });

      generated.push({
        code: coupon.code,
        milestone: coupon.milestone,
        discountPercent: coupon.discountPercent,
        status: coupon.status,
      });
    } catch (error) {
      const prismaError = error as Prisma.PrismaClientKnownRequestError;
      if (prismaError.code === 'P2002') {
        continue;
      }
      throw error;
    }
  }

  res.status(200).json({ generated });
});

app.get('/api/admin/reports/summary', async (_req, res) => {
  const [orders, revenue, couponCounts, quantitySummary] = await Promise.all([
    prisma.order.findMany({
      select: {
        subtotalMinor: true,
        discountMinor: true,
        totalMinor: true,
      },
    }),
    prisma.order.aggregate({
      _sum: {
        subtotalMinor: true,
        discountMinor: true,
        totalMinor: true,
      },
    }),
    prisma.coupon.groupBy({
      by: ['status'],
      _count: { status: true },
    }),
    prisma.orderItem.groupBy({
      by: ['productId', 'productName'],
      _sum: { quantity: true },
    }),
  ]);

  const grossRevenue = revenue._sum.subtotalMinor ?? 0;
  const totalDiscounts = revenue._sum.discountMinor ?? 0;
  const netRevenue = revenue._sum.totalMinor ?? 0;

  const couponsGenerated = await prisma.coupon.count();
  const couponsAvailable = couponCounts.find((entry) => entry.status === 'AVAILABLE')?._count.status ?? 0;
  const couponsRedeemed = couponCounts.find((entry) => entry.status === 'REDEEMED')?._count.status ?? 0;

  res.status(200).json({
    totalSuccessfullyPlacedOrders: orders.length,
    productsPurchased: quantitySummary.map((entry) => ({
      productId: entry.productId,
      productName: entry.productName,
      quantity: entry._sum.quantity ?? 0,
    })),
    grossRevenueMinor: grossRevenue,
    totalDiscountsMinor: totalDiscounts,
    netRevenueMinor: netRevenue,
    couponsGenerated,
    couponsAvailable,
    couponsRedeemed,
  });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof AppError) {
    res.status(error.statusCode).json(toErrorResponse(error));
    return;
  }

  if (error instanceof Error) {
    res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: error.message,
      },
    });
    return;
  }

  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Unexpected server error.',
    },
  });
});
