# GIS Bot — Deployment & Mobile App Guide

This document covers everything needed to take the GIS bot from a local development setup to a production VPS deployment with a React Native mobile app for field users and admins.

---

## Table of Contents

1. [Current Architecture](#1-current-architecture)
2. [What Changes for Production](#2-what-changes-for-production)
3. [VPS Requirements](#3-vps-requirements)
4. [Docker Setup](#4-docker-setup)
5. [VPS Deployment Step-by-Step](#5-vps-deployment-step-by-step)
6. [Security Hardening](#6-security-hardening)
7. [Backup & Maintenance](#7-backup--maintenance)
8. [Mobile App Architecture](#8-mobile-app-architecture)
9. [Mobile App Implementation](#9-mobile-app-implementation)
10. [Backend Changes for Mobile](#10-backend-changes-for-mobile)
11. [End-to-End Flow](#11-end-to-end-flow)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Current Architecture

```
Your Machine (localhost)
├── Flask Management Server (port 5000)
│   ├── GIS Dashboard (Leaflet.js map)
│   ├── Management UI (start/stop listeners, configure groups)
│   ├── REST API (messages, reports, locations, exports)
│   └── SQLite database (data/messages.db)
├── WhatsApp Listener (child process, Node.js + Chromium)
│   └── whatsapp-web.js → HTTP POST → Flask API
└── Telegram Listener (child process, Node.js)
    └── grammy bot → HTTP POST → Flask API
```

**How it works today:**
- You run `./start.sh` which starts the Flask server
- From the management UI (`http://localhost:5000/management`) you start/stop WhatsApp and Telegram listeners
- Listeners forward messages to the Flask API
- The dashboard shows locations on a map

**What's limiting about this:**
- Must keep your computer running 24/7
- Only accessible from your local network
- Field users can't access the dashboard
- No mobile access

---

## 2. What Changes for Production

### Overview of changes

| Component | Local (now) | Production (target) |
|-----------|------------|-------------------|
| **Server** | Your laptop | VPS (cloud server) |
| **Access** | localhost only | Public IP or domain |
| **Security** | API key, localhost CORS | HTTPS, firewall, API key |
| **Process management** | Manual start/stop | Docker with auto-restart |
| **Database** | SQLite file | SQLite file (same, volume-mounted) |
| **WhatsApp auth** | QR in terminal/UI | QR in management UI (same) |
| **Client apps** | Web browser | Web browser + React Native mobile app |

### Why Docker?

Docker packages your entire application (Python, Node.js, Chromium, all dependencies) into a single container that runs identically everywhere. Without Docker, you'd need to manually install Python 3.11, Node.js 20, Chromium, and all system libraries on the VPS — and hope nothing conflicts. Docker eliminates that.

### Why a single container?

Your architecture has the Flask server spawning listeners as child processes using `subprocess.Popen`. This means all three services (Flask + WhatsApp listener + Telegram listener) need to run in the same process space. A single Docker container is the natural fit. If you later want to split them into separate containers, the `ServiceManager` would need to be replaced with Docker API calls or Kubernetes — not worth the complexity at this scale.

---

## 3. VPS Requirements

### Minimum specs

| Resource | Minimum | Recommended | Why |
|----------|---------|-------------|-----|
| **RAM** | 2 GB | 4 GB | Chromium (for WhatsApp) uses ~500MB-1GB. Flask + Telegram use ~200MB. |
| **CPU** | 1 vCPU | 2 vCPU | Chromium needs CPU for rendering. |
| **Disk** | 20 GB | 40 GB | OS + Docker images + SQLite + media files. |
| **OS** | Ubuntu 22.04+ | Ubuntu 24.04 LTS | Docker support, long-term security updates. |
| **Network** | Public IPv4 | Public IPv4 | Required for WhatsApp/Telegram to connect. |

### Cost estimate

| Provider | Spec | Monthly cost |
|----------|------|-------------|
| DigitalOcean | 2GB RAM, 1 vCPU, 50GB | ~$12/mo |
| Hetzner | 4GB RAM, 2 vCPU, 40GB | ~$5/mo |
| AWS Lightsail | 2GB RAM, 1 vCPU, 60GB | ~$10/mo |
| Vultr | 2GB RAM, 1 vCPU, 55GB | ~$10/mo |
| Oracle Cloud | 4GB RAM, 2 vCPU, 100GB | Free tier (Always Free) |

**Recommendation:** Hetzner or Oracle Cloud free tier for cost. DigitalOcean for simplicity.

---

## 4. Docker Setup

### 4.1 Dockerfile

Create `Dockerfile` at the project root. This installs both Python and Node.js in one image, plus Chromium for WhatsApp:

```dockerfile
# Dockerfile
FROM ubuntu:22.04

# Prevent interactive prompts during install
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv \
    nodejs npm \
    chromium-browser \
    fonts-liberation \
    libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 \
    libgtk-3-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 (Ubuntu 22.04 ships older Node)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for whatsapp-web.js
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

# Copy package files first (for Docker cache)
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY whatsapp-listener/package.json whatsapp-listener/
COPY telegram-listener/package.json telegram-listener/

# Install Node dependencies
RUN npm install

# Copy Python requirements and install
COPY gis-processor/requirements.txt gis-processor/
RUN pip3 install --no-cache-dir -r gis-processor/requirements.txt

# Copy all source code
COPY . .

# Build TypeScript
RUN npm run build --workspaces

# Expose Flask port
EXPOSE 5000

# Start the management server
CMD ["python3", "gis-processor/app.py"]
```

### What this Dockerfile does, line by line:

1. **`FROM ubuntu:22.04`** — Starts from a clean Ubuntu base. We need Ubuntu (not Alpine) because Chromium requires glibc.
2. **System packages** — Installs Python, Node.js, Chromium, and all the shared libraries Chromium needs to render web pages.
3. **Node.js 20** — Ubuntu 22.04 ships Node 12, so we install Node 20 from NodeSource.
4. **`PUPPETEER_EXECUTABLE_PATH`** — Tells whatsapp-web.js where Chromium is installed (inside the container, not at `/snap/bin/chromium`).
5. **Package files first** — Docker caches each layer. By copying `package.json` files before source code, `npm install` only re-runs when dependencies change, not when you edit code.
6. **`npm install`** — Installs all workspace dependencies (shared, whatsapp-listener, telegram-listener).
7. **`pip3 install`** — Installs Python dependencies for the Flask server.
8. **Source code** — Copies everything else.
9. **`npm run build --workspaces`** — Compiles all TypeScript to JavaScript.
10. **`CMD`** — Starts the Flask management server, which then manages listeners as child processes.

### 4.2 Docker Compose

Create `docker-compose.yml` at the project root:

```yaml
# docker-compose.yml
version: '3.8'

services:
  gis-bot:
    build: .
    container_name: gis-bot
    ports:
      - "5000:5000"
    volumes:
      # Persist database and media across restarts
      - ./data:/app/gis-processor/data
      # Mount .env for secrets
      - ./.env:/app/.env:ro
      # Mount config
      - ./config.yaml:/app/config.yaml:ro
      # Persist WhatsApp auth session
      - ./whatsapp-auth:/app/whatsapp-listener/auth_info
    environment:
      - PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
    restart: unless-stopped
    # Chromium needs these for running without a display
    security_opt:
      - seccomp:unconfined
    shm_size: '512mb'  # Chromium needs shared memory
```

### What the volumes do:

| Volume | Purpose |
|--------|---------|
| `./data` | SQLite database, media files, log files. Survives container rebuilds. |
| `./.env` | Secrets (API key, Telegram token). Read-only mount. |
| `./config.yaml` | Configuration. Read-only mount. |
| `./whatsapp-auth` | WhatsApp session data. Survives container rebuilds so you don't re-scan QR every time. |

### 4.3 .dockerignore

Create `.dockerignore` to keep the image small:

```
node_modules/
dist/
venv/
data/
.env
*.log
auth_info/
.wwebjs_cache/
.git/
```

### 4.4 Update config.yaml for production

The `python_service.host` must be `0.0.0.0` (not `localhost`) so Flask listens on all interfaces inside the container:

```yaml
python_service:
  host: "0.0.0.0"   # Changed from localhost
  port: 5000
```

### 4.5 Update whatsapp-listener for Docker

The Chromium path needs to come from the environment variable instead of being hardcoded:

In `whatsapp-listener/src/index.ts`, change:
```typescript
executablePath: '/snap/bin/chromium',
```
To:
```typescript
executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/snap/bin/chromium',
```

This way it uses `/snap/bin/chromium` locally and `/usr/bin/chromium-browser` in Docker.

### 4.6 Test locally

Before deploying to a VPS, test the Docker setup on your machine:

```bash
# Build the image (first time takes 5-10 minutes)
docker-compose build

# Start in foreground (see logs)
docker-compose up

# Or start in background
docker-compose up -d

# Check it's running
docker-compose ps

# View logs
docker-compose logs -f gis-bot

# Stop
docker-compose down
```

Open `http://localhost:5000/management` — it should work exactly like before.

---

## 5. VPS Deployment Step-by-Step

### 5.1 Provision a VPS

Choose any provider from the table in Section 3. Create a server with:
- Ubuntu 22.04 or 24.04 LTS
- At least 2GB RAM
- SSH key authentication (not password)

You'll get a public IP address, e.g., `203.0.113.50`.

### 5.2 Connect to the VPS

```bash
ssh root@203.0.113.50
```

### 5.3 Initial server setup

```bash
# Update system
apt update && apt upgrade -y

# Create a non-root user
adduser gisbot
usermod -aG sudo gisbot

# Switch to the new user
su - gisbot
```

### 5.4 Install Docker

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Add your user to the docker group (so you don't need sudo)
sudo usermod -aG docker $USER

# Log out and back in for group change to take effect
exit
su - gisbot

# Verify Docker works
docker --version
docker-compose --version
```

If `docker-compose` isn't found, install it:
```bash
sudo apt install docker-compose-plugin -y
# Use `docker compose` (with space) instead of `docker-compose`
```

### 5.5 Set up firewall

```bash
# Allow SSH (so you don't lock yourself out!)
sudo ufw allow OpenSSH

# Allow HTTP and HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Allow Flask port (for direct access during testing)
sudo ufw allow 5000/tcp

# Enable firewall
sudo ufw enable

# Verify
sudo ufw status
```

### 5.6 Clone your project

```bash
# Clone from GitHub (or upload with scp)
git clone https://github.com/davidelka/gis_whatsup_helper.git
cd gis_whatsup_helper

# Create the .env file with your secrets
nano .env
```

Add to `.env`:
```
TELEGRAM_BOT_TOKEN=your_telegram_token_here
API_KEY=your_api_key_here
```

Generate a new API key:
```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

### 5.7 Build and start

```bash
# Build the Docker image
docker compose build

# Start in background
docker compose up -d

# Check it's running
docker compose ps

# View logs
docker compose logs -f
```

### 5.8 Test access

From your local machine:
```
http://203.0.113.50:5000/management
http://203.0.113.50:5000/dashboard
```

Replace `203.0.113.50` with your VPS IP.

### 5.9 (Optional) Set up HTTPS with nginx

If you later add a domain, create `nginx.conf`:

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://gis-bot:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Add nginx to `docker-compose.yml`:
```yaml
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf
    depends_on:
      - gis-bot
    restart: unless-stopped
```

For SSL with Let's Encrypt:
```bash
# Install certbot on the VPS (not in Docker)
sudo apt install certbot -y

# Stop nginx temporarily
docker compose stop nginx

# Get certificate
sudo certbot certonly --standalone -d yourdomain.com

# Mount certs into nginx container (add to volumes)
# - /etc/letsencrypt:/etc/letsencrypt:ro

# Auto-renew certs
sudo crontab -e
# Add: 0 3 * * * certbot renew --pre-hook "docker compose stop nginx" --post-hook "docker compose start nginx"
```

---

## 6. Security Hardening

### Already in place
- API key authentication on all mutation endpoints
- CORS restricted to specific origins
- XSS protection (HTML escaping) in dashboard and management UI
- Secrets in `.env` (not in code/git)
- Input validation on media uploads (size limit, filename sanitization)

### Additional steps for production

| Action | Command | Why |
|--------|---------|-----|
| Disable root SSH login | Edit `/etc/ssh/sshd_config`: `PermitRootLogin no` | Prevent brute-force on root |
| Use SSH keys only | `PasswordAuthentication no` in sshd_config | Eliminate password attacks |
| Install fail2ban | `sudo apt install fail2ban` | Auto-ban IPs after failed login attempts |
| Close port 5000 after nginx setup | `sudo ufw delete allow 5000/tcp` | Only nginx (port 80/443) should be public |
| Set file permissions on .env | `chmod 600 .env` | Only the owner can read secrets |
| Regular updates | `sudo apt update && sudo apt upgrade -y` | Security patches |

### CORS update for mobile app

When the mobile app is ready, update CORS in `gis-processor/app.py`:
```python
CORS(app, origins=[
    'http://localhost:5000',
    'http://127.0.0.1:5000',
    '*'  # Or specific mobile app origin
])
```

Since mobile apps don't send `Origin` headers like browsers do, and you already have API key auth, you can safely allow all origins when API key is required.

---

## 7. Backup & Maintenance

### What to back up

| File/Directory | Contains | Backup frequency |
|---|---|---|
| `data/messages.db` | All messages, reports, locations, groups | Daily |
| `data/media/` | Photos from messages | Daily |
| `.env` | Secrets | Once (or when changed) |
| `whatsapp-auth/` | WhatsApp session | Once (or when re-authenticated) |

### Simple backup script

Create `backup.sh` on the VPS:

```bash
#!/bin/bash
BACKUP_DIR="/home/gisbot/backups"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# Stop briefly for consistent SQLite backup
docker compose stop gis-bot
cp -r data/ "$BACKUP_DIR/data_$DATE"
docker compose start gis-bot

echo "Backup created: $BACKUP_DIR/data_$DATE"

# Keep only last 7 days
find $BACKUP_DIR -maxdepth 1 -mtime +7 -exec rm -rf {} \;
```

Add to crontab:
```bash
crontab -e
# Add: 0 2 * * * /home/gisbot/gis_whatsup_helper/backup.sh
```

### Updating the application

```bash
cd ~/gis_whatsup_helper

# Pull latest code
git pull

# Rebuild and restart
docker compose build
docker compose up -d

# Check it's healthy
docker compose logs --tail=20
```

### Monitoring

Check if the bot is running:
```bash
# Container status
docker compose ps

# Health check
curl http://localhost:5000/health

# View recent logs
docker compose logs --tail=50 -f
```

---

## 8. Mobile App Architecture

### Why React Native (Expo)?

| Option | Pros | Cons |
|--------|------|------|
| **React Native (Expo)** | Cross-platform (iOS + Android), JavaScript/TypeScript, fast development, OTA updates | Slightly larger app size |
| WebView wrapper | Simplest, reuses web UI | Feels like a web page, no native features |
| Full native (Swift/Kotlin) | Best performance | 2x the work (separate iOS + Android codebases) |

**Expo** is the right choice because:
- Your team already uses TypeScript
- It builds for both iOS and Android from one codebase
- Expo Go lets you test on real devices without building
- Over-the-air (OTA) updates push fixes without App Store review

### Who uses the app

```
┌──────────────┐        ┌──────────────┐
│  Field Users  │        │    Admins     │
│              │        │              │
│ View map     │        │ All of left + │
│ See reports  │        │ Start/stop    │
│ Filter data  │        │ Configure     │
│ Export KML   │        │ Disconnect    │
│ Share links  │        │ Manage groups │
└──────┬───────┘        └──────┬───────┘
       │                       │
       └───────┐   ┌──────────┘
               ▼   ▼
        ┌──────────────┐
        │  React Native │
        │   Mobile App  │
        │  (Expo)       │
        └──────┬───────┘
               │ HTTPS + API Key
               ▼
        ┌──────────────┐
        │  VPS Server   │
        │  Flask API    │
        └──────────────┘
```

### Role-based access

The app should have two roles:
- **Viewer** (field users): Can see dashboard, reports, map, export data
- **Admin**: All viewer features + service management, group config, disconnect

Simplest implementation: Admin enters the API key in app settings. Without the key, management features are hidden.

---

## 9. Mobile App Implementation

### 9.1 Project structure

```
mobile/
├── app/                        # Expo Router (file-based routing)
│   ├── (tabs)/                 # Tab navigator layout
│   │   ├── _layout.tsx         # Tab bar configuration
│   │   ├── index.tsx           # Dashboard tab (map + reports)
│   │   ├── management.tsx      # Management tab (services + groups)
│   │   └── settings.tsx        # Settings tab (server URL, API key)
│   ├── _layout.tsx             # Root layout
│   └── report/[id].tsx         # Report detail screen
├── components/
│   ├── MapView.tsx             # Leaflet or react-native-maps
│   ├── ReportCard.tsx          # Report summary card
│   ├── ServiceCard.tsx         # Service control card
│   ├── GroupList.tsx           # Group configuration list
│   ├── QrModal.tsx             # WhatsApp QR code scanner
│   └── FilterBar.tsx           # Date/group/tag filters
├── lib/
│   ├── api.ts                  # API client with auth
│   ├── types.ts                # TypeScript interfaces
│   └── storage.ts              # Secure storage for API key
├── app.json                    # Expo config
├── package.json
└── tsconfig.json
```

### 9.2 Create the project

```bash
# From the project root
npx create-expo-app@latest mobile --template tabs
cd mobile

# Install key dependencies
npx expo install react-native-maps
npx expo install expo-secure-store
npx expo install expo-location
npm install @tanstack/react-query axios
```

### 9.3 API Client (`lib/api.ts`)

This is the core module that talks to your VPS:

```typescript
// mobile/lib/api.ts
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

const API_TIMEOUT = 10000;

class ApiClient {
    private baseUrl: string = '';
    private apiKey: string = '';

    async init() {
        this.baseUrl = await SecureStore.getItemAsync('server_url') || '';
        this.apiKey = await SecureStore.getItemAsync('api_key') || '';
    }

    private headers() {
        const h: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.apiKey) h['X-API-Key'] = this.apiKey;
        return h;
    }

    // ---- Read endpoints (no auth needed) ----

    async getGeoJson() {
        const res = await axios.get(`${this.baseUrl}/api/geojson`, { timeout: API_TIMEOUT });
        return res.data;
    }

    async getReports(params?: Record<string, string>) {
        const res = await axios.get(`${this.baseUrl}/reports`, { params, timeout: API_TIMEOUT });
        return res.data;
    }

    async getStats() {
        const res = await axios.get(`${this.baseUrl}/stats`, { timeout: API_TIMEOUT });
        return res.data;
    }

    async getServices() {
        const res = await axios.get(`${this.baseUrl}/api/services`, { timeout: API_TIMEOUT });
        return res.data;
    }

    async getAuthState(service: string) {
        const res = await axios.get(`${this.baseUrl}/api/services/${service}/auth`, { timeout: API_TIMEOUT });
        return res.data;
    }

    // ---- Write endpoints (auth required) ----

    async startService(name: string) {
        const res = await axios.post(`${this.baseUrl}/api/services/${name}/start`, {}, { headers: this.headers(), timeout: API_TIMEOUT });
        return res.data;
    }

    async stopService(name: string) {
        const res = await axios.post(`${this.baseUrl}/api/services/${name}/stop`, {}, { headers: this.headers(), timeout: API_TIMEOUT });
        return res.data;
    }

    async disconnectService(name: string) {
        const res = await axios.post(`${this.baseUrl}/api/services/${name}/disconnect`, {}, { headers: this.headers(), timeout: API_TIMEOUT });
        return res.data;
    }

    // ... more endpoints as needed
}

export const api = new ApiClient();
```

### 9.4 Key screens

**Dashboard (index.tsx):**
- Top half: Map showing all locations from `/api/geojson`
- Bottom half: Scrollable list of recent reports
- Pull-to-refresh to reload data
- Tap a report card to zoom to its location on the map
- Filter bar: date picker, group selector, tag filter

**Management (management.tsx):**
- Two service cards (WhatsApp, Telegram) with status, start/stop, disconnect
- QR code modal (opens camera-like view showing the QR image)
- Group list with toggles and delete
- Discovered groups as add buttons
- Only visible if API key is set in settings

**Settings (settings.tsx):**
- Server URL input (e.g., `http://203.0.113.50:5000`)
- API Key input (stored in SecureStore, never visible after entry)
- Connection test button ("Test connection" — calls `/health`)
- About section

### 9.5 Key dependencies explained

| Package | What it does | Why you need it |
|---------|-------------|-----------------|
| `expo-router` | File-based navigation (like Next.js for mobile) | Tab bar, screen navigation |
| `react-native-maps` | Native Google/Apple maps | Show locations on a real map |
| `expo-secure-store` | Encrypted key-value storage | Store API key securely on device |
| `@tanstack/react-query` | Data fetching with caching + auto-refresh | Poll services every 2s, cache reports |
| `axios` | HTTP client | Talk to your Flask API |
| `expo-location` | Device GPS | (Future) Let field users share their own location |

### 9.6 Building and distributing

**For testing (no App Store needed):**
```bash
# Install Expo Go on your phone (from App Store / Play Store)
cd mobile
npx expo start
# Scan the QR code with Expo Go app
```

**For production distribution:**
```bash
# Build APK for Android (no Play Store account needed)
npx eas build --platform android --profile preview

# This gives you a .apk file you can share directly
# Field users install it by opening the APK link
```

**For App Store / Play Store (later):**
```bash
# Build for stores
npx eas build --platform all --profile production
npx eas submit --platform android
npx eas submit --platform ios
```

---

## 10. Backend Changes for Mobile

### 10.1 CORS for mobile

Mobile apps using `fetch` or `axios` don't send browser `Origin` headers the same way. Since you already have API key auth, the simplest approach is to allow all origins when a valid API key is present.

Update `gis-processor/app.py`:
```python
# Allow all origins — API key is the real access control
CORS(app, origins='*')
```

### 10.2 Bind to 0.0.0.0

Already covered in Section 4.4. The Flask server must listen on all interfaces, not just localhost:

```yaml
# config.yaml
python_service:
  host: "0.0.0.0"
  port: 5000
```

### 10.3 (Future) Push notifications

When a new report comes in, notify the mobile app:

1. Add `expo-notifications` to the mobile app
2. On app launch, register for push notifications and send the Expo push token to the server
3. Add a `POST /api/register-device` endpoint on the server
4. When a new report arrives at `POST /report`, send a push notification to all registered devices

This is a future enhancement — the app works fine without it using polling.

---

## 11. End-to-End Flow

Here's what happens after everything is deployed:

```
1. Admin opens mobile app
2. Enters VPS IP + API key in Settings
3. Taps "Start" on WhatsApp service card
   → Mobile app POST /api/services/whatsapp/start
   → Flask spawns WhatsApp listener process
   → Listener starts Chromium, generates QR
   → QR data POSTed to /api/services/whatsapp/auth
4. Admin taps "Scan QR" on mobile
   → Mobile app GET /api/services/whatsapp/auth → gets qr_data
   → Renders QR code on screen
   → Admin scans with WhatsApp phone app
5. WhatsApp listener authenticates
   → POSTs { status: 'authenticated' }
   → Mobile app shows "Connected" badge
6. Field user sends message with location in WhatsApp group
   → WhatsApp listener receives it
   → Parses message, extracts location
   → POSTs to /message endpoint
   → Stored in SQLite
7. Admin opens Dashboard tab on mobile
   → App fetches /api/geojson
   → Shows location on the map
   → Report card appears in the list
8. Admin exports KML for the day
   → App fetches /export/kml
   → Shares via device share sheet
```

---

## 12. Troubleshooting

### Docker issues

| Problem | Solution |
|---------|---------|
| Container exits immediately | `docker compose logs gis-bot` — check for Python/Node errors |
| Chromium crashes in Docker | Ensure `shm_size: '512mb'` in docker-compose.yml |
| WhatsApp QR not showing | Check listener logs. May need `--no-sandbox` (already set) |
| "Cannot find module" errors | `docker compose build --no-cache` to rebuild from scratch |
| SQLite "database is locked" | Only one process should write at a time (already the case) |

### Mobile app issues

| Problem | Solution |
|---------|---------|
| "Network Error" | Check server URL in settings, ensure VPS firewall allows the port |
| 401 Unauthorized | API key in app doesn't match `.env` on server |
| Map not loading | Check `react-native-maps` setup, ensure Google Maps API key (Android) |
| QR code not rendering | Check auth endpoint returns `qr_data`, ensure `qrcode` JS library loads |

### VPS issues

| Problem | Solution |
|---------|---------|
| Can't SSH | Check firewall allows port 22. Try from a different network. |
| High memory usage | Chromium is hungry. Check `docker stats`. Consider 4GB VPS. |
| Database growing large | Check `du -sh data/`. Clean old media: `find data/media -mtime +90 -delete` |
| WhatsApp disconnects | Session expired. Go to management UI, click Disconnect, then Start again for new QR. |

---

## Implementation Checklist

### Phase 1: Docker (do first)
- [ ] Create `Dockerfile`
- [ ] Create `docker-compose.yml`
- [ ] Create `.dockerignore`
- [ ] Update `config.yaml` host to `0.0.0.0`
- [ ] Update Chromium path to use env variable
- [ ] Test locally: `docker compose up`
- [ ] Verify management UI works in Docker
- [ ] Verify WhatsApp QR works in Docker

### Phase 2: VPS deployment
- [ ] Provision VPS
- [ ] Install Docker
- [ ] Set up firewall
- [ ] Clone repo + create `.env`
- [ ] `docker compose up -d`
- [ ] Test from outside: `http://VPS_IP:5000/management`

### Phase 3: Mobile app
- [ ] Create Expo project in `mobile/`
- [ ] Build API client (`lib/api.ts`)
- [ ] Build Settings screen (server URL + API key)
- [ ] Build Management screen (services + groups)
- [ ] Build Dashboard screen (map + reports)
- [ ] Test with Expo Go on phone
- [ ] Build APK for distribution

### Phase 4: Polish
- [ ] (Optional) Add domain + HTTPS
- [ ] (Optional) Push notifications
- [ ] (Optional) App Store submission
- [ ] Set up automated backups
- [ ] Document for team members
