import Fastify from "fastify";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import { RealtimeConnection } from "./openaiRealtime.js";
import process from "node:process";
import cors from "@fastify/cors";
import twilio from "twilio";
import fs from "node:fs";
import { startWavFile, appendUlawBase64, finalizeWav } from "./twilioStream.js";
import ffmpeg from "fluent-ffmpeg";
import { publishMixJob } from "./queue.js"

// (Removed local WAV helpers; handled in twilioStream.js)

// In windows

const ffmpegPath = "C:\\ffmpeg\\bin\\ffmpeg.exe";
const ffprobePath = "C:\\ffmpeg\\bin\\ffprobe.exe";

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables. You must have OpenAI Realtime API access.
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}
const PORT = +(process.env.PORT || 5050);

// Initialize Fastify
const fastify = Fastify();
fastify.register(cors);
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);


// check for tmp folder if not present then create it
if (!fs.existsSync("tmp")) {
  fs.mkdirSync("tmp");
}

// Removed Agents SDK setup; using RealtimeConnection directly

// Root Route
fastify.get("/", async (_request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});

fastify.post("/calls", async (request, reply) => {
  try {
    const { phoneNumber } = request.body;

    const twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    const twimlResponse = `
        <?xml version="1.0" encoding="UTF-8"?>
        <Response>
            <Connect>   
                <Stream url="wss://fd8aca9f8034.ngrok-free.app/media-stream" />
            </Connect>
        </Response>`.trim();

    twilioClient.calls.create({
      to: phoneNumber,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml: twimlResponse,
    });

    console.log(`Outgoing call to ${phoneNumber}`);
    reply.send({ message: "Call initiated successfully!" });
  } catch (error) {
    console.error("Error initiating call.", error);
    reply.status(500).send({ message: "Error initiating call." });
  }
});

// Route for Twilio to handle incoming and outgoing calls
// <Say> punctuation to improve text-to-speech translation
fastify.all("/incoming-call", async (request, reply) => {
  const twimlResponse = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>O.K. you can start talking!</Say>
    <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
    </Connect>
</Response>`.trim();
  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for media-stream
// Per-call sessions keyed by streamSid (stateless across instances, in-memory per process)
const sessions = new Map();

fastify.register(async (scopedFastify) => {
  scopedFastify.get(
    "/media-stream",
    { websocket: true },
    async (connection) => {
      let currentStreamSid = null;
      const SILENCE_FRAME_MS = 20; // Twilio ~20ms frames
      const SILENCE_FRAME_SAMPLES = 160; // 8kHz * 0.02s
      const SILENCE_BASE64 = Buffer.alloc(SILENCE_FRAME_SAMPLES, 0xff).toString("base64");

      function startAgentSilenceFiller(session) {
        if (session.agentSilenceTimer) return;
        session.agentSilenceTimer = setInterval(() => {
          const now = Date.now();
          if (now - session.lastAgentWriteMs >= SILENCE_FRAME_MS) {
            appendUlawBase64(session.agentPath, SILENCE_BASE64);
            session.lastAgentWriteMs = now;
          }
        }, SILENCE_FRAME_MS);
      }
      function stopAgentSilenceFiller(session) {
        if (session.agentSilenceTimer) {
          clearInterval(session.agentSilenceTimer);
          session.agentSilenceTimer = null;
        }
      }

      function cleanupSession(session) {
        try { finalizeWav(session.callerPath); } catch {}
        try { finalizeWav(session.agentPath); } catch {}
        stopAgentSilenceFiller(session);
        if (session.rt) {
          try { session.rt.close(); } catch {}
          session.rt = null;
        }
      }

      try {
        const twilioWebSocket = connection; // Twilio WebSocket instance

        // When client sends a message
        twilioWebSocket.on("message", (msg) => {
          msg = JSON.parse(msg.toString());

          if (msg.event === "start") {
            const streamSid = msg.start.streamSid;
            const callSid = msg.start.callSid;
            currentStreamSid = streamSid;


            const callerPath = `tmp/${callSid}-caller.wav`;
            const agentPath = `tmp/${callSid}-agent.wav`;
            const outputPath = `tmp/${callSid}-mixed.wav`;

            startWavFile(callerPath);
            startWavFile(agentPath);

            const session = {
              streamSid,
              callSid,
              callerPath,
              agentPath,
              outputPath,
              rt: new RealtimeConnection(OPENAI_API_KEY, {
                instructions: "You are a helpful assistant.",
              }),
              lastAgentWriteMs: Date.now(),
              agentSilenceTimer: null,
            };
            sessions.set(streamSid, session);
            startAgentSilenceFiller(session);

            session.rt.onMessage((data) => {
              console.log("Realtime:", data?.type || data);
              switch (data.type) {
                case "response.audio.delta": {
                  const audioDelta = {
                    event: "media",
                    streamSid: session.streamSid,
                    media: { payload: data.delta },
                  };
                  session.lastAgentWriteMs = Date.now();
                  appendUlawBase64(session.agentPath, data.delta);
                  try { twilioWebSocket.send(JSON.stringify(audioDelta)); } catch {}
                  break;
                }
                default:
                  break;
              }
            });
          }

          if (msg.event === "media") {
            const s = sessions.get(currentStreamSid);
            if (s) {
              appendUlawBase64(s.callerPath, msg.media.payload);
              if (s.rt) {
                s.rt.sendMessage({ type: "input_audio_buffer.append", audio: msg.media.payload });
              }
            }
          }

          if (msg.event === "stop") {
            const s = sessions.get(currentStreamSid);
            if (s) {
              finalizeWav(s.callerPath);
              finalizeWav(s.agentPath);
              stopAgentSilenceFiller(s);
              if (s.rt) {
                s.rt.sendMessage({ type: "input_audio_buffer.commit" });
              }
            }
          }
        });

        // When connection is closed
        twilioWebSocket.on("close", async (code, reason) => {
          console.log("Connection closed");
          const s = sessions.get(currentStreamSid);
          if (s) {
            // finalize files and stop timers
            cleanupSession(s);
            // enqueue background mixing + transcription job
            try {
              await publishMixJob({
                callSid: s.callSid,
                streamSid: s.streamSid,
                callerPath: s.callerPath,
                agentPath: s.agentPath,
                outputPath: s.outputPath,
              });
            } catch (e) {
              console.error("Failed to publish mix job:", e);
            }
            // Remove from session map
            sessions.delete(currentStreamSid);
          }
          console.log("Code:", code, "Reason:", reason.toString());
        });

        // On error
        twilioWebSocket.on("error", (err) => {
          console.error("Error in Server WebSocket:", err);
        });
      } catch (error) {
        console.error("Error getting media stream.", error);
      }

      // Removed Agents session usage
    }
  );
});

fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});

process.on("SIGINT", () => {
  fastify.close();
  process.exit(0);
});
