import amqp from "amqplib";
import { getDb } from "./db";

const RABBIT_URL = process.env.RABBIT_URL ?? "amqp://outbox-rabbitmq:5672";
const EXCHANGE = "domain-events";
const QUEUE = process.env.QUEUE_NAME ?? "orders-service";
const ROUTING_KEYS = (process.env.ROUTING_KEYS && process.env.ROUTING_KEYS.trim().length > 0
  ? process.env.ROUTING_KEYS
  : "OrderCreated")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

type InboxDoc = {
  messageId: string;
  receivedAt: Date;
  routingKey: string;
};

async function main() {
  // Mongo
  const db = await getDb();
  const inbox = db.collection<InboxDoc>("inbox");

  // Unique index => déduplication
  await inbox.createIndex({ messageId: 1 }, { unique: true });

  // Rabbit
  const conn = await amqp.connect(RABBIT_URL);
  const ch = await conn.createChannel();

  await ch.assertExchange(EXCHANGE, "topic", { durable: true });
  const q = await ch.assertQueue(QUEUE, { durable: true });
  for (const key of ROUTING_KEYS) {
    await ch.bindQueue(q.queue, EXCHANGE, key);
    }

  ch.prefetch(1);

  console.log(`Consumer started. queue=${QUEUE} routingKeys=${ROUTING_KEYS.join(",")}`);

  await ch.consume(
    q.queue,
    async (msg) => {
      if (!msg) return;

      const messageId = msg.properties.messageId;
      const routingKey = msg.fields.routingKey;

      if (!messageId) {
        // En prod: tu peux nack + DLQ. Pour la démo: on log et on jette.
        console.error("Missing messageId, cannot dedupe. Rejecting.");
        ch.nack(msg, false, false);
        return;
      }

      // 1) Try to insert into inbox (atomic unique constraint)
      try {
        await inbox.insertOne({
          messageId,
          receivedAt: new Date(),
          routingKey,
        });
      } catch (e: any) {
        // Duplicate key => already processed
        if (e?.code === 11000) {
          console.log("Duplicate message ignored:", messageId);
          ch.ack(msg);
          return;
        }

        console.error("Inbox insert failed:", e);
        // requeue = true => on réessaie plus tard
        ch.nack(msg, false, true);
        return;
      }

      // 2) Process business logic
      try {
        const payload = JSON.parse(msg.content.toString("utf-8"));

        console.log("Processing:", {
          routingKey,
          messageId,
          payload,
        });

        // TODO: ici tu feras ton vrai traitement
        // ex: update read-model, call external service, etc.

        // 3) ACK only after successful processing
        ch.ack(msg);
      } catch (e) {
        console.error("Processing failed:", e);

        // Important: on a déjà écrit dans inbox => messageId “consumé”
        // En prod, on mettrait un statut FAILED + retry métier / DLQ.
        // Pour la démo: on n'ack pas => requeue (mais ça ferait doublon sans stratégie)
        // Donc on préfère ack + log (ou bien stocker status=FAILED et gérer retries).
        ch.ack(msg);
      }
    },
    { noAck: false }
  );
}

main().catch((e) => {
  console.error("Consumer crashed:", e);
  process.exit(1);
});