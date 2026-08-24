# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=22.21.1
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="NestJS"

# NestJS app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"


# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

# Skip Puppeteer's bundled browser download — we use the system Chromium instead
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install node modules
COPY package-lock.json package.json ./
RUN npm ci --include=dev

# Copy application code
COPY . .

# Build application
RUN npm run build


# Final stage for app image
FROM base

# Install Chromium for Puppeteer to use
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y chromium chromium-sandbox && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives

# Copy built application
COPY --from=build /app /app

# Start the server by default, this can be overwritten at runtime
EXPOSE 4000
ENV PORT=4000
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium"
CMD [ "npm", "run", "start" ]
