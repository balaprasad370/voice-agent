import WebSocket from "ws";

const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

export class RealtimeConnection {
  instructions = "You are a helpful assistant.";
  ws = null;

  constructor(apiKey, { instructions } = {}) {
    if (instructions) this.instructions = instructions;
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: "Bearer " + apiKey,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    this.ws.on("open", () => {
      setTimeout(() => this.initializeSession(), 100);
    });
  }

  initializeSession() {
    const sessionUpdate = {
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad" },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "alloy",
        instructions: this.instructions,
        modalities: ["text", "audio"],
        temperature: 0.8,
      },
    };
    this.sendMessage(sessionUpdate);
  }

  onMessage(handler) {
    this.ws.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());
        handler(data);
      } catch {
        // ignore
      }
    });
  }

  sendMessage(message) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}


