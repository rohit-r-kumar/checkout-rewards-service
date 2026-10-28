import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const products = [
    { sku: 'KB-100', name: 'Mechanical Keyboard', priceMinor: 5980, inventory: 8 },
    { sku: 'MS-200', name: 'Wireless Mouse', priceMinor: 2490, inventory: 12 },
    { sku: 'MN-300', name: '27-inch Monitor', priceMinor: 18990, inventory: 4 },
    { sku: 'HD-400', name: 'Noise-Cancelling Headphones', priceMinor: 8990, inventory: 3 },
    { sku: 'USB-500', name: 'USB-C Hub', priceMinor: 3490, inventory: 15 },
    { sku: 'CAM-600', name: '1080p Webcam', priceMinor: 7990, inventory: 2 },
  ];

  await prisma.$transaction(
    products.map((product) =>
      prisma.product.upsert({
        where: { sku: product.sku },
        create: product,
        update: {
          name: product.name,
          priceMinor: product.priceMinor,
          inventory: product.inventory,
        },
      }),
    ),
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
