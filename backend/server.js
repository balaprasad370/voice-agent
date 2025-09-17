import Fastify from "fastify";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import {
  RealtimeAgent,
  RealtimeSession,
  backgroundResult,
  tool,
} from "@openai/agents/realtime";
import { TwilioRealtimeTransportLayer } from "@openai/agents-extensions";
import { hostedMcpTool } from "@openai/agents";
import { z } from "zod";
import process from "node:process";
import cors from "@fastify/cors";
import twilio from "twilio";

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

const weatherTool = tool({
  name: "weather",
  description: "Get the weather in a given location.",
  parameters: z.object({
    location: z.string(),
  }),
  execute: async ({ location }) => {
    return backgroundResult(`The weather in ${location} is sunny.`);
  },
});

const secretTool = tool({
  name: "secret",
  description: "A secret tool to tell the special number.",
  parameters: z.object({
    question: z
      .string()
      .describe(
        "The question to ask the secret tool; mainly about the special number."
      ),
  }),
  execute: async ({ question }) => {
    return `The answer to ${question} is 42.`;
  },
  needsApproval: true,
});

const agent = new RealtimeAgent({
  name: "Greeter",
  instructions:
    "You are a friendly assistant. When you use a tool always first say what you are about to do.",
  tools: [secretTool, weatherTool],
});

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
      const twilioTransportLayer = new TwilioRealtimeTransportLayer({
        twilioWebSocket: connection,
      });

      const session = new RealtimeSession(agent, {
        transport: twilioTransportLayer,
        model: "gpt-realtime",
        config: {
          audio: {
            output: {
              voice: "verse",
            },
          },
        },
      });

      await session.connect({
        apiKey: OPENAI_API_KEY,
      });
      console.log("Connected to the OpenAI Realtime API");
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
