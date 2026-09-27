# Build from the repository root, since the agent imports the Photos protocol as source:
#   docker build -f packages/photo-storage-agent/Dockerfile -t photo-storage-agent .
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# The protocol types the agent shares with the Photos worker (type-only at runtime).
COPY packages/photos/shared /app/packages/photos/shared
COPY packages/photo-storage-agent/package.json /app/packages/photo-storage-agent/package.json
RUN cd /app/packages/photo-storage-agent \
  && npm install --omit=dev --no-package-lock exifr@7.1.3 sharp@0.34.5 \
  && npm cache clean --force
COPY packages/photo-storage-agent/src /app/packages/photo-storage-agent/src

WORKDIR /app/packages/photo-storage-agent
USER node
VOLUME ["/config"]
EXPOSE 8080
ENTRYPOINT ["node", "src/main.ts"]
CMD ["run"]
