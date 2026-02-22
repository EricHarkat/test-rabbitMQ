# Test RabbitMQ - MongoDB Outbox Pattern (TypeScript)

EDA(even-driven architecture)
In an event-driven architecture components communicate primarily via events rather than direct calls.

This project demonstrates a production-style implementation of the **Outbox Pattern** using:

- Node.js (Express)
- TypeScript
- MongoDB (Replica Set + Transactions)
- RabbitMQ
- Docker Compose

---

## 🧠 Architecture
Client
↓
API (Express)
↓ (Mongo Transaction)
MongoDB

orders

outbox
↓
Outbox Worker
↓
RabbitMQ (domain-events exchange)


---

## 🎯 Goal

Ensure reliable event publishing when using a database and a message broker.

Instead of:

1. Save data in DB
2. Publish event to RabbitMQ

We use:

1. MongoDB transaction:
   - Insert order
   - Insert outbox event
2. Separate worker publishes events
3. Mark event as published

This guarantees:
- No lost events
- No partial failures
- At-least-once delivery

---

## 🐳 Running the project

Start all services:

```bash
docker compose up -d --build
```

## Service

- API → http://localhost:3000
- RabbitMQ UI → http://localhost:15672
- MongoDB → localhost:27017

## 27017

## 🧪 Create an order

```bash
curl -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"customerId":"c1","items":[{"sku":"ABC","qty":2}]}'
```

## Collection

orders

Stores business data.

outbox

Stores domain events before they are published.

Fields:

- type

- payload

- createdAt

- publishedAt

- attempts

- lastError

- lockedAt

## RabbitMq

- Monitoring : http://localhost:15672
- Login by default : guest / guest

## Summary 

Le Order Service est découplé des autres services.
Il publie des événements métier (faits qui se sont produits (event)), sans connaître les consommateurs.

Lorsqu’un client crée une commande, le service insère l’ordre et l’événement correspondant dans la collection outbox, dans une transaction MongoDB.

Un worker lit ensuite les événements non publiés dans l’outbox et les publie vers un exchange RabbitMQ, puis marque ces événements comme publiés.

L’exchange route les messages vers une ou plusieurs queues en fonction du routing key et du type d’exchange (topic).

Les consumers écoutent leurs queues respectives et traitent les messages reçus.

Comme RabbitMQ fonctionne en at-least-once delivery, un message peut être livré plusieurs fois.
Pour garantir l’idempotence, le consumer enregistre chaque message traité dans une collection inbox avec un index unique sur messageId, afin d’éviter tout traitement en double.