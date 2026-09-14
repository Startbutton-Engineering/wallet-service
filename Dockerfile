# =========================
# Build stage
# =========================
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Prevent mongodb-memory-server from downloading MongoDB during npm install
ENV MONGOMS_DISABLE_POSTINSTALL=1

COPY package.json package-lock.json ./

RUN npm ci

COPY . ./

RUN npm run build

# =========================
# Runtime stage
# =========================
FROM node:22-bookworm-slim AS runtime

# Create a non-root user
RUN addgroup --gid 1001 --system nestjs && \
    adduser --system --uid 1001 --ingroup nestjs --no-create-home nestuser

WORKDIR /app


#Change ownership of the working directory to the non-root user.
RUN chown -R nestuser:nestjs /app

# Copy  artifacts and runtime dependencies
COPY --from=build --chown=nestuser:nestjs /app ./


USER nestuser

EXPOSE 3003

CMD ["node", "dist/main.js"]
