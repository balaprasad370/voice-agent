## Voice Agent (Twilio Media Streams + OpenAI Realtime)

Fastify backend that connects Twilio Voice Media Streams to OpenAI Realtime (g711_ulaw, 8 kHz). The server forwards Twilio audio frames to OpenAI Realtime, records both user and agent audio as μ-law WAV, fills gaps with μ-law silence for smooth playback, and can optionally mix user+agent audio using FFmpeg (Windows paths shown).

### Key points (at a glance)
- **What it does**:
  - Bridges Twilio Voice Media Streams with OpenAI Realtime (two-way audio)
  - Streams caller audio to OpenAI; relays assistant audio back to the call
  - Records caller and agent audio as μ-law WAV (8 kHz, mono)
  - Inserts μ-law silence when no agent audio to keep timing smooth
  - Optional: mixes caller+agent tracks into a single file via FFmpeg
- **Tech stack**:
  - Node.js, Fastify, @fastify/websocket
  - OpenAI Realtime (WebSocket, g711_ulaw)
  - Twilio Voice Media Streams
  - Audio: μ-law WAV handling, fluent-ffmpeg (FFmpeg)
- **Tools used**:
  - ws (WebSocket client), dotenv, cors
  - FFmpeg (and ffprobe) for audio mixing (optional)
  - ngrok (to expose local server for Twilio)

### Project structure
- `backend/`: Fastify server, Twilio + OpenAI Realtime integration
- `frontend/`: Minimal HTML form to trigger `POST /calls`

### System design (Kubernetes: architecture, scaling, sticky sessions, load balancer)
This section describes a production-ready deployment on Kubernetes (K8s) for Twilio Media Streams + OpenAI Realtime.

High-level architecture:
```
Twilio Voice (SIP/Media Streams)
        │  HTTPS (webhooks) / WSS (media)
        ▼
   Ingress + TLS (NGINX or Cloud LB/Ingress)
        │  HTTP(S)/WSS → Service (ClusterIP)
        ▼
   Fastify Pods (Deployment, N replicas)
        │        │
        │        └─► Redis (optional) — call/session state & coordination
        │
        └─► OpenAI Realtime (wss)

Optional:
 - Object storage/PVC for recordings (instead of local disk)
 - Prometheus + Grafana for metrics/alerts
```

Key recommendations:
- Pods must be stateless for scale-out. Persist per-call state (e.g., `CallSid → session metadata`) in Redis or another store.
- Each Twilio WebSocket is a single long-lived connection and remains pinned to one pod; sticky sessions are not required for the WS itself.
- For any additional HTTP callbacks needing pod affinity, cookie-based affinity will not work with Twilio (it does not send cookies). Prefer stateless design or external state (Redis). If you still need stickiness for browser traffic, enable Ingress cookie affinity for those paths only.
- Use proper TLS (valid CA) on the public endpoint; Twilio requires HTTPS/WSS.
- Set resource requests/limits and readiness/liveness probes to enable reliable HPA.

Example manifests (minimal):

Deployment and Service:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: voice-agent
spec:
  replicas: 3
  selector:
    matchLabels:
      app: voice-agent
  template:
    metadata:
      labels:
        app: voice-agent
    spec:
      containers:
        - name: backend
          image: your-registry/voice-agent:latest
          imagePullPolicy: IfNotPresent
          env:
            - name: OPENAI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: voice-agent-secrets
                  key: OPENAI_API_KEY
            - name: TWILIO_ACCOUNT_SID
              valueFrom:
                secretKeyRef:
                  name: voice-agent-secrets
                  key: TWILIO_ACCOUNT_SID
            - name: TWILIO_AUTH_TOKEN
              valueFrom:
                secretKeyRef:
                  name: voice-agent-secrets
                  key: TWILIO_AUTH_TOKEN
            - name: TWILIO_PHONE_NUMBER
              valueFrom:
                secretKeyRef:
                  name: voice-agent-secrets
                  key: TWILIO_PHONE_NUMBER
            - name: PORT
              value: "5050"
          ports:
            - containerPort: 5050
          readinessProbe:
            httpGet:
              path: /
              port: 5050
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /
              port: 5050
            initialDelaySeconds: 15
            periodSeconds: 20
          resources:
            requests:
              cpu: "250m"
              memory: "256Mi"
            limits:
              cpu: "1"
              memory: "1Gi"
---
apiVersion: v1
kind: Service
metadata:
  name: voice-agent
spec:
  selector:
    app: voice-agent
  ports:
    - port: 80
      targetPort: 5050
      protocol: TCP
  type: ClusterIP
```

Ingress (NGINX; enables WebSocket and optional cookie affinity for browser paths):
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: voice-agent
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt
    # Cookie affinity helps only for browser traffic; Twilio does not send cookies.
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/session-cookie-name: "route"
spec:
  tls:
    - hosts:
        - voice.yourdomain.com
      secretName: voice-agent-tls
  rules:
    - host: voice.yourdomain.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: voice-agent
                port:
                  number: 80
```

Horizontal Pod Autoscaler (CPU-based; consider custom metrics like active WS):
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: voice-agent
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: voice-agent
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
```

Load balancer options:
- Managed Ingress (recommended): terminate TLS at Ingress (NGINX, AWS ALB, GKE Ingress). Ensure WebSocket upgrade is allowed (NGINX does this automatically).
- Service `type: LoadBalancer`: expose the Service directly with a public LB if you do not need path-based routing. Still requires TLS termination (use a cloud LB that supports TLS) and correct WS support.

Sticky sessions considerations:
- WebSockets: each call’s WS is a single connection pinned to one pod. No stickiness needed.
- Twilio webhooks (HTTP): Twilio does not carry session cookies. Design handlers to be stateless and store session context in Redis by `CallSid`/`StreamSid`.

Storage for recordings:
- Prefer object storage (e.g., S3/GCS/Azure Blob) or a per-pod ephemeral disk uploaded asynchronously at end-of-call. If you need node storage, mount a PVC and write per-call unique files to avoid contention.

Observability:
- Expose metrics (connections, active calls, CPU, memory) via Prometheus. Alert on high active calls per pod and WS failure rates. Log Twilio `start/stop` and OpenAI connect/disconnect events.

### Prerequisites
- Node.js 18+ and npm
- An OpenAI API key with access to the Realtime API
- A Twilio account with a voice-capable phone number
- A public HTTPS/WSS URL for Twilio to reach your server (e.g., via `ngrok`)
- FFmpeg (for optional mixing). On Windows, install to `C:\ffmpeg\bin` or add to PATH.

### 1) Backend setup
1. Open a terminal in the `backend` directory and install dependencies:
   ```bash
   cd backend
   npm install
   # Realtime WS client
   npm install ws
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

If you plan to mix audio on Windows using FFmpeg, ensure the paths are set in `backend/server.js`:

```js
// Windows example paths
const ffmpegPath = "C:\\ffmpeg\\bin\\ffmpeg.exe";
const ffprobePath = "C:\\ffmpeg\\bin\\ffprobe.exe";
```

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

### How it works (high level)
- On Twilio `'start'`: the server creates/initializes two μ-law WAVs via `twilioStream.js`, starts a silence filler for the agent track, and opens an OpenAI Realtime WS (`openaiRealtime.js`).
- On Twilio `'media'`: the base64 μ-law is appended to `tmp/twilio_audio.wav` and forwarded to OpenAI via `input_audio_buffer.append`.
- On OpenAI `'response.audio.delta'`: the base64 μ-law delta is appended to `tmp/agent_audio.wav` and sent back to Twilio immediately.
- Silence filler: every 20 ms, if no delta arrived, a μ-law 0xFF frame is appended to agent WAV to keep timing smooth.
- On `'stop'`/close: files are finalized (RIFF/data sizes written). Optionally, FFmpeg can mix both WAVs.

Notes:
- Audio format is `g711_ulaw` (8 kHz, mono, 8-bit); μ-law silence byte is `0xFF`.
- File writes use a single descriptor to avoid Windows `EBUSY`.

### Troubleshooting
- Missing key at startup: If you see `Missing OpenAI API key`, create `backend/.env` with `OPENAI_API_KEY`.
- Outbound call connects but no audio/agent: Most often the `<Stream url>` is wrong or not publicly reachable. Make sure it’s `wss://<your-public-domain>/media-stream` and the tunnel is active.
- Twilio Trial: Calls to unverified numbers fail. Verify the destination or upgrade your account.
- CORS issues from the file:// frontend: Serve the frontend via a simple local server (see above).
- Port conflicts: Change `PORT` in `.env` and restart. Update your `ngrok` command as well.
- Ngrok URL changes on restart: Update the `<Stream url>` in `server.js` and, if using inbound, your Twilio webhook.
- Windows `EBUSY` on WAV writes: close any viewer/preview of the WAVs, exclude `backend/tmp` from antivirus/indexer, and keep per-call unique outputs if running multiple streams.

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


