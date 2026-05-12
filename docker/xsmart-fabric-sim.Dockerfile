FROM node:22-alpine

WORKDIR /app
COPY scripts/xsmart/local-bc3-fabric-server.mjs /app/server.mjs

EXPOSE 18645
VOLUME ["/data"]

CMD ["node", "/app/server.mjs"]
