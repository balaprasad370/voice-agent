## Voice Agent (Twilio Media Streams + OpenAI Realtime)

This project contains a Fastify backend that connects Twilio Voice Media Streams to OpenAI Realtime, and a simple frontend page to initiate outbound calls.

### Project structure
- `backend/`: Fastify server, Twilio + OpenAI Realtime integration
- `frontend/`: Minimal HTML form to trigger `POST /calls`

### Prerequisites
- Node.js 18+ and npm
- An OpenAI API key with access to the Realtime API
- A Twilio account with a voice-capable phone number
- A public HTTPS/WSS URL for Twilio to reach your server (e.g., via `ngrok`)

### 1) Backend setup
1. Open a terminal in the `backend` directory and install dependencies:
   ```bash
   cd backend
   npm install
   ```
2. Create a `.env` file in `backend/` with the following variables:
   ```bash
   # OpenAI
   OPENAI_API_KEY=sk-...              # Must have Realtime access

   # Twilio
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=your_auth_token
   TWILIO_PHONE_NUMBER=+12345678900   # Your Twilio voice-capable number in E.164

   # Server
   PORT=5050                          # Optional (defaults to 5050)
   ```
3. Start the server:
   ```bash
   npm start
   ```
   You should see: `Server is listening on port 5050`.

### 2) Expose the server publicly (for Twilio)
Twilio must connect to your server over the public internet using `https`/`wss`.

Using `ngrok` as an example:
```bash
ngrok http 5050
```
Note the generated `https://<subdomain>.ngrok-free.app` URL. The matching WebSocket URL is `wss://<subdomain>.ngrok-free.app/media-stream`.

Important:
- In `backend/server.js`, the outbound call flow (`POST /calls`) currently uses a placeholder WSS URL in the TwiML `<Stream>` tag. Replace it with your ngrok domain if you plan to use the outbound call feature:
  ```xml
  <Stream url="wss://<your-ngrok-subdomain>.ngrok-free.app/media-stream" />
  ```
- The inbound call flow (`/incoming-call`) builds the WSS URL from the request host automatically. For inbound calls, configure Twilio to point your number’s Voice webhook to:
  ```
  https://<your-ngrok-subdomain>.ngrok-free.app/incoming-call
  ```

### 3) Twilio configuration
- Ensure `TWILIO_PHONE_NUMBER` is a Twilio voice-capable number you own.
- For outbound calls triggered by the frontend (`POST /calls`):
  - Make sure `server.js` TwiML uses your current public `wss://.../media-stream` URL as described above.
  - On Twilio trial accounts, you can only call verified numbers.
- For inbound calls (optional):
  - In the Twilio Console, set your phone number’s Voice webhook to `https://<your-ngrok-subdomain>.ngrok-free.app/incoming-call` (HTTP `POST` or `GET` are both fine for this simple TwiML).

### 4) Frontend usage
The frontend is a static HTML file that POSTs to `http://localhost:5050/calls`.

Options to run it:
1) Open directly: Double-click `frontend/index.html` to open in your browser.
2) Serve locally (recommended to avoid file:// CORS quirks):
   ```bash
   npx serve frontend -l 8080
   ```
   Then open `http://localhost:8080`.

To place an outbound call:
1. Ensure the backend is running and the TwiML in `server.js` points to your current `wss://.../media-stream` URL.
2. Open the frontend, enter a full E.164 number (e.g., `+19195551234`), then click “Make Call”.

### Notes about OpenAI Realtime
- The backend uses model `gpt-realtime` with audio output voice `verse`. Ensure your OpenAI account has Realtime access.

### Troubleshooting
- Missing key at startup: If you see `Missing OpenAI API key`, create `backend/.env` with `OPENAI_API_KEY`.
- Outbound call connects but no audio/agent: Most often the `<Stream url>` is wrong or not publicly reachable. Make sure it’s `wss://<your-public-domain>/media-stream` and the tunnel is active.
- Twilio Trial: Calls to unverified numbers fail. Verify the destination or upgrade your account.
- CORS issues from the file:// frontend: Serve the frontend via a simple local server (see above).
- Port conflicts: Change `PORT` in `.env` and restart. Update your `ngrok` command as well.
- Ngrok URL changes on restart: Update the `<Stream url>` in `server.js` and, if using inbound, your Twilio webhook.

### Scripts
From `backend/`:
```bash
npm start # runs: node server.js
```

### Security
- Keep your `.env` out of version control.
- Treat your OpenAI and Twilio credentials as secrets.

### License
This repository does not specify a license. Add one if you plan to distribute.


