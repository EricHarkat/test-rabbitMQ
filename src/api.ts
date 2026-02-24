import express, { Request, Response } from "express";
import { getClient, getDb } from "./db";
import { ObjectId } from "mongodb";
import "dotenv/config";

const app = express();
app.use(express.json());

const DB_NAME = process.env.DB_NAME ?? "outbox_demo";

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
  const session = client.startSession();

  try {
    let orderId = "";

    await session.withTransaction(async () => {
      // IMPORTANT: use the same client + session inside the transaction
      const db = client.db(DB_NAME);
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

app.patch("/orders/:id", async (req, res) => {
  const { id } = req.params;
  const { items } = req.body as { items?: Array<{ sku: string; qty: number }> };

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items is required (non-empty array)" });
  }

  const client = await getClient();
  const session = client.startSession();

  try {
    await session.withTransaction(async () => {
      // IMPORTANT: use the same client + session inside the transaction
      const db = client.db(DB_NAME);
      const orders = db.collection("orders");
      const outbox = db.collection("outbox");

      const orderId = new ObjectId(id);

      // 1) Update order
      const upd = await orders.updateOne(
        { _id: orderId },
        { $set: { items, updatedAt: new Date() } },
        { session }
      );

      if (upd.matchedCount === 0) {
        // Force rollback transaction
        throw new Error("ORDER_NOT_FOUND");
      }

      // 2) Insert outbox event
      await outbox.insertOne(
        {
          type: "OrderUpdated",
          aggregateId: orderId, // ObjectId
          payload: { orderId, items },
          createdAt: new Date(),
          publishedAt: null,
          attempts: 0,
          lastError: null,
        },
        { session }
      );
    });

    res.json({ ok: true });
  } catch (e: any) {
    if (String(e?.message) === "ORDER_NOT_FOUND") {
      return res.status(404).json({ error: "order not found" });
    }
    console.error(e);
    res.status(500).json({ error: "update failed" });
  } finally {
    await session.endSession();
  }
});

app.get("/orders", async (_req: Request, res: Response) => {
  // Here we can use getDb() (no transaction/session needed)
  const db = await getDb();
  const orders = db.collection("orders");

  const list = await orders.find().sort({ createdAt: -1 }).limit(20).toArray();
  res.json(list.map((o) => ({ ...o, _id: o._id.toString() })));
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`API running on http://localhost:${port}`));