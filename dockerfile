# Stage 1: Install dependencies
FROM node:22-alpine AS deps

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --only=production

# install pm2 & pm2-runtime here OR in runtime stage
RUN npm install -g pm2 pm2-runtime


# Stage 2: Runtime
FROM node:22-alpine AS runtime

WORKDIR /usr/src/app

# Install global pm2 & pm2-runtime again (needed!)
RUN npm install -g pm2 pm2-runtime

COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .

EXPOSE 5002

CMD ["pm2-runtime", "ecosystem.config.js", "--env", "production"]
