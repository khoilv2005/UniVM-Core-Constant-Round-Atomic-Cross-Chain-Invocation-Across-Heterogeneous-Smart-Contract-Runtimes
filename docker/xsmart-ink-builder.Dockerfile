FROM rust:1.85-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/usr/local/cargo/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    clang \
    cmake \
    git \
    libssl-dev \
    pkg-config \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN rustup component add clippy
RUN rustup component add rust-src

RUN cargo install cargo-contract --locked --version 5.0.3

WORKDIR /work
