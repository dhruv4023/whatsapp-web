# Stage 1: Install dependencies
FROM node:22-alpine AS deps

# Set working directory
WORKDIR /usr/src/app

# Copy package files and install only production deps
COPY package*.json ./
RUN npm ci --only=production

# Stage 2: Copy app and dependencies into minimal image
FROM node:22-alpine AS runtime

WORKDIR /usr/src/app

# Copy only production node_modules from previous stage
COPY --from=deps /usr/src/app/node_modules ./node_modules

# Copy application source code
COPY . .

# Expose port
EXPOSE 5002

# Start the app
CMD ["node", "index.js"]
