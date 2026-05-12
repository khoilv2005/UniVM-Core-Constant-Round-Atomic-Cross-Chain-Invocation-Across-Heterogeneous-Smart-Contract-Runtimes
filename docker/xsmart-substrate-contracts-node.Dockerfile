FROM ubuntu:24.04

ARG SCN_VERSION=v0.42.0
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tar \
    && rm -rf /var/lib/apt/lists/*

RUN curl -L "https://github.com/paritytech/substrate-contracts-node/releases/download/${SCN_VERSION}/substrate-contracts-node-linux.tar.gz" -o /tmp/scn.tar.gz \
    && mkdir -p /opt/scn \
    && tar -xzf /tmp/scn.tar.gz -C /opt/scn \
    && chmod +x /opt/scn/substrate-contracts-node-linux/substrate-contracts-node \
    && ln -sf /opt/scn/substrate-contracts-node-linux/substrate-contracts-node /usr/local/bin/substrate-contracts-node \
    && rm -f /tmp/scn.tar.gz

EXPOSE 9944
VOLUME ["/data"]

ENTRYPOINT ["substrate-contracts-node"]
CMD ["--dev", "--unsafe-rpc-external", "--rpc-methods", "unsafe", "--rpc-cors", "all", "--rpc-port", "9944", "--base-path", "/data"]
