#!/bin/bash
# =============================================================================
# Clean Docker - Stop services, remove images (Redis state is ephemeral: no volume to purge)
# =============================================================================

set -e

echo "🧹 Cleaning Redis Messaging Patterns Docker resources..."
echo ""

# Stop and remove containers, networks (-v also clears the legacy redis-data volume)
echo "📦 Stopping and removing containers, networks..."
docker compose down -v --remove-orphans

# Remove project images
echo ""
echo "🗑️  Removing project images..."
docker rmi redismessagingpatternswithjedis-backend 2>/dev/null || true
docker rmi redismessagingpatternswithjedis-frontend 2>/dev/null || true
docker rmi redis:latest 2>/dev/null || true
docker rmi redis/redisinsight:latest 2>/dev/null || true

echo ""
echo "✅ Docker cleanup complete!"
echo ""
