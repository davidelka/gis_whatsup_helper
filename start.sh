#!/bin/bash
# Start script for GIS Bot (Management Server)
# The management server controls WhatsApp and Telegram listeners

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  GIS Bot - Management Server${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Activate virtual environment if it exists
if [ -f "venv/bin/activate" ]; then
    source venv/bin/activate
fi

echo -e "${GREEN}Starting GIS Processor (Management Server)...${NC}"
echo ""
echo -e "${YELLOW}Dashboard:  http://localhost:5000/dashboard${NC}"
echo -e "${YELLOW}Management: http://localhost:5000/management${NC}"
echo ""
echo "Start/stop WhatsApp and Telegram listeners from the management UI."
echo ""

cd gis-processor && python app.py
