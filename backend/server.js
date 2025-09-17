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
fastify.register(async (scopedFastify) => {
  scopedFastify.get(
    "/media-stream",
    { websocket: true },
    async (connection) => {
      let rt = null;
      let streamSId = null;
      let callSId = null;
      // Agent silence filler controls
      let agentSilenceTimer = null;
      let lastAgentWriteMs = 0;
      const SILENCE_FRAME_MS = 20; // Twilio ~20ms frames
      const SILENCE_FRAME_SAMPLES = 160; // 8kHz * 0.02s
      const SILENCE_BASE64 = Buffer.alloc(SILENCE_FRAME_SAMPLES, 0xff).toString(
        "base64"
      );
      function startAgentSilenceFiller(agentaudioPath) {
        if (agentSilenceTimer) return;
        agentSilenceTimer = setInterval(() => {
          const now = Date.now();
          if (now - lastAgentWriteMs >= SILENCE_FRAME_MS) {
            appendUlawBase64(agentaudioPath, SILENCE_BASE64);
            lastAgentWriteMs = now;
          }
        }, SILENCE_FRAME_MS);
      }
      function stopAgentSilenceFiller() {
        if (agentSilenceTimer) {
          clearInterval(agentSilenceTimer);
          agentSilenceTimer = null;
        }
      }

      try {
        //twilio response from client
        const twilioaudioPath = "tmp/twilio_audio.wav";
        const agentaudioPath = "tmp/agent_audio.wav";

        const twilioWebSocket = connection; // Twilio WebSocket instance

        // When client sends a message
        twilioWebSocket.on("message", (msg) => {
          msg = JSON.parse(msg.toString());

          if (msg.event === "start") {
            streamSId = msg.start.streamSid;
            callSId = msg.start.callSid;

            startWavFile(twilioaudioPath);
            startWavFile(agentaudioPath);
            lastAgentWriteMs = Date.now();
            startAgentSilenceFiller(agentaudioPath);
            // Initialize OpenAI Realtime connection once per call
            rt = new RealtimeConnection(OPENAI_API_KEY, {
              instructions: "You are a helpful assistant.",
            });
            // Optional: log realtime events
            rt.onMessage((data) => {
              console.log("Realtime:", data?.type || data);

              switch (data.type) {
                case "response.audio.delta":
                  const audioDelta = {
                    event: "media",
                    streamSid: streamSId,
                    media: {
                      payload: data.delta,
                    },
                  };
                  // mark recent agent write; this suppresses silence frames
                  lastAgentWriteMs = Date.now();
                  appendUlawBase64(agentaudioPath, data.delta);

                  // Send immediately - no processing delays
                  twilioWebSocket.send(JSON.stringify(audioDelta));
                  break;
                // Add more cases here if needed
                default:
                  break;
              }
            });
          }

          if (msg.event === "media") {
            appendUlawBase64(twilioaudioPath, msg.media.payload);
            // Forward base64 μ-law audio to OpenAI Realtime
            if (rt) {
              rt.sendMessage({
                type: "input_audio_buffer.append",
                audio: msg.media.payload,
              });
            }
          }

          if (msg.event === "stop") {
            finalizeWav(twilioaudioPath);
            finalizeWav(agentaudioPath);
            stopAgentSilenceFiller();
            // Optionally commit audio for processing
            if (rt) {
              rt.sendMessage({ type: "input_audio_buffer.commit" });
            }
          }
        });

        // When connection is closed
        twilioWebSocket.on("close", (code, reason) => {
          console.log("Connection closed");
          // Update WAV sizes
          finalizeWav(twilioaudioPath);
          finalizeWav(agentaudioPath);
          stopAgentSilenceFiller();

          ffmpeg()
            .input(twilioaudioPath)
            .input(agentaudioPath)
            .complexFilter([
              {
                filter: "amix",
                options: {
                  inputs: 2,
                  duration: "first", // or 'longest' / 'shortest'
                  dropout_transition: 0,
                },
                outputs: "mixed",
              },
            ])
            .outputOptions(["-map [mixed]"])
            .on("start", (cmd) => console.log("FFmpeg command:", cmd))
            .on("error", (err, stdout, stderr) => {
              console.error("Error:", err.message);
              console.error("stderr:", stderr);
            })
            .on("end", () => {
              console.log("Mixing complete, file saved:", outputAudioPath);
            })
            .save(outputAudioPath);

          // Close realtime connection
          if (rt) {
            rt.close();
            rt = null;
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
