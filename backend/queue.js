import amqplib from "amqplib";

const QUEUE_NAME = "audio_mix_jobs";

export async function getChannel(url = process.env.AMQP_URL || "amqp://localhost") {
  const conn = await amqplib.connect(url);
  const ch = await conn.createChannel();
  await ch.assertQueue(QUEUE_NAME, { durable: true });
  return { conn, ch };
}

export async function publishMixJob(job, url = process.env.AMQP_URL || "amqp://localhost") {
  const { conn, ch } = await getChannel(url);
  try {
    ch.sendToQueue(QUEUE_NAME, Buffer.from(JSON.stringify(job)), { persistent: true });
  } finally {
    setTimeout(() => { conn.close(); }, 50);
  }
}

export { QUEUE_NAME };


