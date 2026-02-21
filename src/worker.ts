import amqp, { Channel, Connection, ChannelModel } from "amqplib";
import { getDb } from "./db";
import { ObjectId } from "mongodb";


const RABBIT_URL = process.env.RABBIT_URL ?? "amqp://outbox-rabbitmq:5672";
const EXCHANGE = "domain-events";

type OutboxDoc = {
  _id: ObjectId;
  type: string;
  payload: unknown;
  createdAt: Date;
  publishedAt: Date | null;
  attempts: number;
  lastError: string | null;
  lockedAt?: Date;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function connectRabbit(): Promise<{ conn: ChannelModel; ch: Channel }> {
  const conn = await amqp.connect(RABBIT_URL);
  const ch = await conn.createChannel();
  await ch.assertExchange(EXCHANGE, "topic", { durable: true });
  return { conn, ch };
}

async function main() {
  const db = await getDb();
  const outbox = db.collection<OutboxDoc>("outbox");

  // Index utile (facilite le findOneAndUpdate trié)
  await outbox.createIndex({ publishedAt: 1, createdAt: 1 });

  const { conn, ch } = await connectRabbit();
  console.log("Outbox worker started.");

  // boucle infinie simple (pédago)
  while (true) {
    // 1) claim un message (simple “lock”)
    const evt = await outbox.findOneAndUpdate(
        { publishedAt: null, lockedAt: { $exists: false } },
        { $set: { lockedAt: new Date() }, $inc: { attempts: 1 } },
        { sort: { createdAt: 1 }, returnDocument: "after" }
    );

    if (!evt) {
        await sleep(500);
        continue;
    }


    try {
      // 2) publish RabbitMQ
      const routingKey = evt.type; // ex: OrderCreated
      const body = Buffer.from(JSON.stringify(evt.payload));

      ch.publish(EXCHANGE, routingKey, body, {
        contentType: "application/json",
        persistent: true,
        messageId: evt._id.toString(),
      });

      // 3) mark published
      await outbox.updateOne(
        { _id: evt._id },
        { $set: { publishedAt: new Date(), lastError: null }, $unset: { lockedAt: "" } }
      );

      console.log("Published", routingKey, evt._id.toString());
    } catch (e) {
      await outbox.updateOne(
        { _id: evt._id },
        { $set: { lastError: String(e) }, $unset: { lockedAt: "" } }
      );
      console.error("Publish failed", e);
      await sleep(500);
    }
  }

  // jamais atteint
  // await ch.close(); await conn.close();
}

main().catch((e) => {
  console.error("Worker crashed:", e);
  process.exit(1);
});