#!/bin/bash
# =============================================================================
# Stop Docker Compose - Stop all services
# =============================================================================

set -e

echo "🛑 Stopping Redis Messaging Patterns..."
echo ""

docker compose down

echo ""
echo "✅ All services stopped!"

