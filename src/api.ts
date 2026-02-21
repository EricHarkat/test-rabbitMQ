import express, { Request, Response } from "express";
import { getClient, getDb } from "./db";
import "dotenv/config";

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "api" });
});

app.post("/echo", (req: Request, res: Response) => {
  res.json({ received: req.body });
});

app.post("/orders", async (req: Request, res: Response) => {
  const { customerId, items } = req.body as {
    customerId?: string;
    items?: Array<{ sku: string; qty: number }>;
  };

  if (!customerId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Provide customerId and items[]" });
  }

  const client = await getClient();
  const db = await getDb();

  const session = client.startSession();

  try {
    let orderId: string = "";

    await session.withTransaction(async () => {
      const orders = db.collection("orders");
      const outbox = db.collection("outbox");

      const orderDoc = {
        customerId,
        items,
        status: "CREATED",
        createdAt: new Date(),
      };

      const orderInsert = await orders.insertOne(orderDoc, { session });
      orderId = orderInsert.insertedId.toString();

      await outbox.insertOne(
        {
          type: "OrderCreated",
          aggregateId: orderInsert.insertedId,
          payload: { orderId, customerId, items },
          createdAt: new Date(),
          publishedAt: null,
          attempts: 0,
          lastError: null,
        },
        { session }
      );
    });

    return res.status(201).json({ orderId });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Create order failed" });
  } finally {
    await session.endSession();
  }
});

app.get("/orders", async (_req: Request, res: Response) => {
  const db = await getDb();
  const orders = db.collection("orders");

  const list = await orders.find().sort({ createdAt: -1 }).limit(20).toArray();
  res.json(list.map((o) => ({ ...o, _id: o._id.toString() })));
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`API running on http://localhost:${port}`));