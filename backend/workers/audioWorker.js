import amqplib from "amqplib";
import ffmpeg from "fluent-ffmpeg";
import { QUEUE_NAME } from "../queue.js";
import { initSchema, saveTranscription } from "../db.js";
import transcribeAudio from "../transcription.js";

// Optional: set Windows ffmpeg paths via ENV
if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
if (process.env.FFPROBE_PATH) ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);

const AMQP_URL = process.env.AMQP_URL || "amqp://localhost";

async function startWorker() {
  await initSchema();
  const conn = await amqplib.connect(AMQP_URL);
  const ch = await conn.createChannel();
  await ch.assertQueue(QUEUE_NAME, { durable: true });
  ch.prefetch(1);

  console.log("Audio worker listening on queue:", QUEUE_NAME);

  ch.consume(QUEUE_NAME, async (msg) => {
    if (!msg) return;
    const job = JSON.parse(msg.content.toString());
    const { callSid, streamSid, callerPath, agentPath, outputPath } = job;
    try {
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(callerPath)
          .input(agentPath)
          .complexFilter([
            { filter: "amix", options: { inputs: 2, duration: "first", dropout_transition: 0 }, outputs: "mixed" },
          ])
          .outputOptions(["-map [mixed]"])
          .on("start", (cmd) => console.log("FFmpeg command:", cmd))
          .on("error", (err, _stdout, stderr) => {
            console.error("FFmpeg error:", err?.message);
            console.error("stderr:", stderr);
            reject(err);
          })
          .on("end", () => resolve())
          .save(outputPath);
      });

      const transcript = await transcribeAudio(outputPath);
      await saveTranscription(callSid, streamSid, outputPath, transcript);

      ch.ack(msg);
    } catch (err) {
      console.error("Worker job failed:", err);
      ch.nack(msg, false, true); // requeue
    }
  });
}

startWorker().catch((e) => {
  console.error("Worker fatal error:", e);
  process.exit(1);
});


