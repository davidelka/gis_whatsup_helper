#!/bin/bash
# Start script for WhatsApp GIS Listener Bot

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  WhatsApp GIS Listener Bot${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check if tmux is available for running both services
if ! command -v tmux &> /dev/null; then
    echo -e "${YELLOW}Note: tmux not found. You'll need to run services in separate terminals.${NC}"
    echo ""
    echo "Start Python GIS Service:"
    echo "  source venv/bin/activate && cd gis-processor && python app.py"
    echo ""
    echo "Start WhatsApp Listener (in another terminal):"
    echo "  cd whatsapp-listener && npm run dev"
    exit 0
fi

# Start services in tmux
SESSION_NAME="whatsapp-gis-bot"

# Kill existing session if exists
tmux kill-session -t $SESSION_NAME 2>/dev/null

# Create new tmux session with Python GIS Service
echo -e "${GREEN}Starting Python GIS Service...${NC}"
tmux new-session -d -s $SESSION_NAME -n "gis-service"
tmux send-keys -t $SESSION_NAME:gis-service "source venv/bin/activate && cd gis-processor && python app.py" C-m

# Create new window for WhatsApp Listener
echo -e "${GREEN}Starting WhatsApp Listener...${NC}"
tmux new-window -t $SESSION_NAME -n "whatsapp"
tmux send-keys -t $SESSION_NAME:whatsapp "cd whatsapp-listener && npm run dev" C-m

echo ""
echo -e "${GREEN}✅ Both services started in tmux session: ${SESSION_NAME}${NC}"
echo ""
echo "To view the services, run:"
echo -e "  ${BLUE}tmux attach -t ${SESSION_NAME}${NC}"
echo ""
echo "To switch between windows in tmux:"
echo "  Ctrl+B, then 0 (GIS Service)"
echo "  Ctrl+B, then 1 (WhatsApp Listener)"
echo ""
echo "To stop all services:"
echo -e "  ${BLUE}tmux kill-session -t ${SESSION_NAME}${NC}"
echo ""
echo -e "${YELLOW}📊 Dashboard available at: http://localhost:5000/dashboard${NC}"
