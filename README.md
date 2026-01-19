# WhatsApp GIS Listener Bot

A server that listens to WhatsApp groups and captures location data, exporting it to GIS file formats (GeoJSON, Shapefile, KML, GeoPackage).

## Architecture

```
┌─────────────────────┐      HTTP POST      ┌─────────────────────┐
│  WhatsApp Groups    │ ──────────────────► │   Python GIS        │
│  (via Baileys)      │                     │   Processor         │
│  Node.js Service    │                     │   Flask API         │
└─────────────────────┘                     └──────────┬──────────┘
                                                       │
                                                       ▼
                                            ┌─────────────────────┐
                                            │  SQLite Database    │
                                            │  + GIS Exports      │
                                            │  (GeoJSON, SHP...)  │
                                            └─────────────────────┘
```

## Quick Start

### Prerequisites
- Node.js 18+
- Python 3.9+
- A WhatsApp account (recommend using secondary number)

### 1. Install Dependencies

```bash
# Python GIS Processor
cd gis-processor
pip install -r requirements.txt

# WhatsApp Listener
cd ../whatsapp-listener
npm install
```

### 2. Configure Target Groups

Edit `config.yaml` to add your target WhatsApp groups:

```yaml
whatsapp:
  target_groups:
    - name: "My GIS Group"
      id: "123456789012345678@g.us"
```

**How to find group IDs:** Run the WhatsApp listener first - it will log all incoming messages with their group IDs.

### 3. Start the Services

**Option A: Manual (two terminals)**

```bash
# Terminal 1 - Python GIS Service
cd gis-processor
python app.py

# Terminal 2 - WhatsApp Listener
cd whatsapp-listener
npm run dev
```

**Option B: Using the start script (requires tmux)**

```bash
chmod +x start.sh
./start.sh
```

### 4. Authenticate WhatsApp

When the WhatsApp listener starts, scan the QR code with your WhatsApp app:
1. Open WhatsApp on your phone
2. Go to Settings → Linked Devices → Link a Device
3. Scan the QR code displayed in the terminal

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/message` | POST | Receive message from WhatsApp listener |
| `/messages` | GET | List all stored messages |
| `/locations` | GET | List all locations with coordinates |
| `/export/geojson` | GET | Download locations as GeoJSON |
| `/export/shapefile` | GET | Download locations as Shapefile (ZIP) |
| `/export/kml` | GET | Download locations as KML |
| `/export/gpkg` | GET | Download locations as GeoPackage |
| `/stats` | GET | Get statistics about stored data |

## Usage Examples

### Export locations to GeoJSON
```bash
curl http://localhost:5000/export/geojson -o locations.geojson
```

### View statistics
```bash
curl http://localhost:5000/stats
```

### List all locations
```bash
curl http://localhost:5000/locations
```

## File Structure

```
gis_helper_bot/
├── config.yaml              # Shared configuration
├── start.sh                 # Startup script
├── README.md
├── whatsapp-listener/       # Node.js WhatsApp service
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts         # Main entry point
│       ├── config.ts        # Config loader
│       ├── messageHandler.ts # Message parsing
│       └── logger.ts        # Logging setup
└── gis-processor/           # Python GIS service
    ├── requirements.txt
    ├── app.py               # Flask API
    ├── models.py            # Database models
    └── gis_export.py        # GIS export utilities
```

## Supported Message Types

The bot captures all WhatsApp message types:
- ✅ Text messages
- ✅ Location shares
- ✅ Live locations
- ✅ Images (metadata only)
- ✅ Videos (metadata only)
- ✅ Documents (metadata only)
- ✅ Audio messages
- ✅ Stickers
- ✅ Contacts

## ⚠️ Important Notes

1. **Terms of Service**: Using Baileys (unofficial WhatsApp library) violates WhatsApp's ToS. Use at your own risk - your account may be banned.

2. **Secondary Number**: Strongly recommend using a secondary phone number.

3. **Group IDs**: After first run, check the logs to find the group IDs you want to monitor, then add them to `config.yaml`.

4. **Data Storage**: All data is stored in `data/messages.db` (SQLite). Exports go to the `exports/` directory.
