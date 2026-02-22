import amqp from "amqplib";

const RABBIT_URL = process.env.RABBIT_URL ?? "amqp://outbox-rabbitmq:5672";
const EXCHANGE = "domain-events";

// Une queue “par service”
const QUEUE = process.env.QUEUE_NAME ?? "orders-service";

// L’event qu’on veut écouter
const ROUTING_KEY = process.env.ROUTING_KEY ?? "OrderCreated";

async function main() {
  const conn = await amqp.connect(RABBIT_URL);
  const ch = await conn.createChannel();

  await ch.assertExchange(EXCHANGE, "topic", { durable: true });
  const q = await ch.assertQueue(QUEUE, { durable: true });

  await ch.bindQueue(q.queue, EXCHANGE, ROUTING_KEY);

  // Pédago: 1 message à la fois
  ch.prefetch(1);

  console.log(`Consumer started. queue=${QUEUE} routingKey=${ROUTING_KEY}`);

  await ch.consume(
    q.queue,
    async (msg) => {
      if (!msg) return;

      try {
        const raw = msg.content.toString("utf-8");
        const payload = JSON.parse(raw);

        console.log("Received:", {
          routingKey: msg.fields.routingKey,
          messageId: msg.properties.messageId,
          payload,
        });

        ch.ack(msg);
      } catch (e) {
        console.error("Consume failed:", e);
        // pour la démo: on jette le message
        ch.nack(msg, false, false);
      }
    },
    { noAck: false }
  );
}

main().catch((e) => {
  console.error("Consumer crashed:", e);
  process.exit(1);
});