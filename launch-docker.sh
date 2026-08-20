#!/bin/bash
# =============================================================================
# Launch Docker Compose - Build, Start, and optionally Follow Logs
# =============================================================================
# Usage:
#   ./launch-docker.sh              # Start (rebuild only if image missing)
#   ./launch-docker.sh --build      # Force rebuild frontend & backend images
#   ./launch-docker.sh --follow     # Start and follow logs
#   ./launch-docker.sh -f           # Start and follow logs (short)
#   ./launch-docker.sh --build -f   # Rebuild + follow logs
#   ./launch-docker.sh --keep-data  # Do NOT flush Redis (keep the previous run's data)
#
# Every run starts from an EMPTY Redis keyspace (this is a demo). Redis itself is
# ephemeral (no volume, no AOF/RDB), and this script also FLUSHALLs before the
# backend starts, so relaunching over an already-running stack is clean too.
# =============================================================================

set -e

# Parse arguments
FOLLOW_LOGS=false
FORCE_BUILD=false
KEEP_DATA=false
for arg in "$@"; do
    case $arg in
        --follow|-f)
            FOLLOW_LOGS=true
            ;;
        --build|-b)
            FORCE_BUILD=true
            ;;
        --keep-data|-k)
            KEEP_DATA=true
            ;;
    esac
done

echo "🚀 Starting Redis Messaging Patterns..."
echo ""

# -------------------------------------------------------------------------
# Step 1: Pull latest Redis images
# -------------------------------------------------------------------------
echo "📥 Pulling latest Redis images..."
docker pull redis:latest --quiet
docker pull redis/redisinsight:latest --quiet
echo "   ✅ Redis images up to date"
echo ""

# -------------------------------------------------------------------------
# Step 2: Build backend/frontend images
# -------------------------------------------------------------------------
BACKEND_IMAGE="redismessagingpatternswithjedis-backend"
FRONTEND_IMAGE="redismessagingpatternswithjedis-frontend"

BUILD_ARGS=""

if [ "$FORCE_BUILD" = true ]; then
    echo "🔨 Force rebuild requested"
    BUILD_ARGS="--build"
else
    if ! docker image inspect "$BACKEND_IMAGE" > /dev/null 2>&1; then
        echo "🔨 Backend image not found, will build..."
        BUILD_ARGS="--build"
    else
        echo "   ✅ Backend image exists"
    fi

    if ! docker image inspect "$FRONTEND_IMAGE" > /dev/null 2>&1; then
        echo "🔨 Frontend image not found, will build..."
        BUILD_ARGS="--build"
    else
        echo "   ✅ Frontend image exists"
    fi
fi

echo ""

# -------------------------------------------------------------------------
# Step 3: Hand the demo an empty Redis
# -------------------------------------------------------------------------
# The backend creates its consumer groups in its CommandLineRunners, so the flush
# must happen while the backend is DOWN -- otherwise FLUSHALL deletes the groups
# out from under a running backend and every claim-based pattern breaks.
if [ "$KEEP_DATA" = true ]; then
    echo "💾 --keep-data: keeping the previous run's Redis data"
    echo ""
else
    echo "🧹 Starting from an empty Redis..."
    docker compose stop backend > /dev/null 2>&1 || true

    docker compose up -d redis
    printf '   waiting for Redis to be healthy'
    REDIS_READY=false
    for _ in $(seq 1 60); do
        if [ "$(docker inspect -f '{{.State.Health.Status}}' redis-messaging-redis 2>/dev/null)" = "healthy" ]; then
            REDIS_READY=true
            break
        fi
        printf '.'
        sleep 1
    done
    printf '\n'

    if [ "$REDIS_READY" != true ]; then
        echo "   ❌ Redis did not become healthy in 60s - aborting instead of starting on unknown state"
        echo "      Inspect with: docker compose logs redis"
        exit 1
    fi

    docker compose exec -T redis redis-cli flushall > /dev/null
    echo "   ✅ Redis keyspace empty (DBSIZE=$(docker compose exec -T redis redis-cli dbsize | tr -d '\r'))"
    echo ""
fi

# -------------------------------------------------------------------------
# Step 4: Start all services
# -------------------------------------------------------------------------
echo "🐳 Starting containers..."
docker compose up -d $BUILD_ARGS

echo ""
echo "✅ All services started!"
echo ""
echo "📍 Access URLs:"
echo "   • Frontend:      http://localhost:4200"
echo "   • Backend API:   http://localhost:8080/api"
echo "   • Redis Insight: http://localhost:5540"
echo "   • Redis:         redis://default@redis-messaging-redis:6379"
echo ""

# Follow logs if requested
if [ "$FOLLOW_LOGS" = true ]; then
    echo "📋 Following logs (Ctrl+C to stop)..."
    echo ""
    docker compose logs -f
else
    echo "💡 To follow logs, run: docker compose logs -f"
    echo "   Or restart with: ./launch-docker.sh --follow"
    echo "💡 Redis is flushed on every launch; use --keep-data to keep the previous run."
fi
