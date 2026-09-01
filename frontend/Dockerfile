# =============================================================================
# Redis Messaging Patterns - Frontend Dockerfile
# Multi-stage build for Angular application
# =============================================================================

# Stage 1: Build
FROM node:24-alpine AS build

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build for production
RUN npm run build

# Stage 2: Serve with Nginx
FROM nginx:alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/

# Copy built application
COPY --from=build /app/dist/redis-messaging-patterns-frontend/browser /usr/share/nginx/html

# nginx workers run as the unprivileged `nginx` user and do not own these files, so they read
# them through the "other" bits. Set the modes explicitly instead of a blanket `chmod -R a+r`:
# `a+r` never adds the +x directories need to be traversed, and never clears an execute bit that
# a build artifact should not carry. `X` applies +x to directories only.
RUN chmod -R u=rwX,go=rX /usr/share/nginx/html

# Expose port
EXPOSE 80

# Health check
# Use 127.0.0.1 (not localhost): localhost resolves to IPv6 [::1] in the
# container, but nginx only listens on IPv4 (`listen 80;`) → connection refused.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]

