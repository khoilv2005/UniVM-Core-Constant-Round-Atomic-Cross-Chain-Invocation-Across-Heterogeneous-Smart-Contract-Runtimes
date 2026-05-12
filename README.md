# UniVM-Core

Research artifact for **UniVM-Core**, a prototype for constant-round atomic cross-chain invocation across heterogeneous smart-contract runtimes.

This repository contains smart-contract prototypes, relayer code, benchmark harnesses, raw result artifacts, and figure-generation scripts used to reproduce the reported evaluation. The artifact is intended for review, replication, and follow-on systems research, not production deployment.

## Artifact Scope

UniVM-Core studies atomic cross-chain invocation across heterogeneous smart-contract runtimes. The prototype includes:

- UBTL translation from source-available frontend logic into typed IR and verified EVM clones.
- VASSP canonical state serialization for EVM, WASM/ink-style, and Fabric-style layouts.
- Proof-adapter boundaries for imported state evidence and update validation.
- Call-tree execution on one execution-chain transaction after state import.
- Atomic lock, rollback, commit, update, and ACK handling.
- Baseline implementations and benchmark harnesses for IntegrateX, AtomCI, and GPACT-style comparisons.

The repository separates measured prototype behavior from stronger production adapter instantiations. ZK/light-client proof generation, full Fabric endorsement verification, and full Substrate finality verification are treated as stronger adapter deployments in the reported study.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `figures/` | Retained figures and figure sources for reproduction. |
| `contracts/` | Solidity contracts for UniVM-Core and baseline protocols. |
| `relayer/` | Go relayer and proof/evidence transport components. |
| `scripts/` | Deployment, benchmark, summarization, and plotting scripts. |
| `scripts/benchmark/` | RQ1, RQ3, RQ4, memory-gas, and verifier-gas benchmark drivers. |
| `scripts/figures/` | Scripts that regenerate retained figures from raw results. |
| `scripts/rq2/` | Translation and live-VM semantic validation scripts. |
| `configs/` | Chain and relayer configuration files. |
| `manifests/` | Benchmark manifests used by relayer configs. |
| `benchmark-results/` | Curated raw JSON/CSV artifacts used in tables and figures. |
| `test/` | Unit and integration tests for protocol components. |
| `zk/` | SP1/RISC Zero proof-adapter prototype sources and examples. |


## Main Reproduction Targets

The retained artifact supports the main evaluation targets:

- **RQ1:** latency and depth scaling under homogeneous and heterogeneous settings.
- **RQ2:** translation and semantic validation for UBTL-generated clones.
- **RQ3:** throughput, EVM-chain gas, contention latency, translated-code overhead, and memory-impedance bounds.
- **RQ4:** concurrent multi-region VM workload with no-contention and hot-lock contention settings.
- **Verifier microbenchmark:** Besu EVM gas and receipt-confirmation latency for proof-adapter verification calls.
- **Figures:** architecture, RQ1 three-panel results, RQ3 four-panel scalability results, and memory-gas scaling.

## Prerequisites

Expected tools:

- Node.js and npm
- Hardhat
- Go
- Python 3 with `matplotlib` and `numpy`
- Docker for local chain or service experiments
- Besu/QBFT nodes for the reported EVM testbed
- Optional Fabric and WASM/ink tooling for heterogeneous endpoint experiments

Install JavaScript dependencies:

```bash
npm ci
```

Build the Go relayer:

```bash
cd relayer
go mod tidy
go build ./cmd/relayer
cd ..
```

Compile contracts:

```bash
npx hardhat compile
npx hardhat compile --config hardhat.xsmart-bc1.config.ts
npx hardhat compile --config hardhat.integratex-bc1.config.ts
npx hardhat compile --config hardhat.atom-bc1.config.ts
npx hardhat compile --config hardhat.gpact-bc1.config.ts
```

## Regenerate Figures

Run from the repository root:

```bash
python scripts/figures/make_architect_figure.py
python scripts/benchmark/plot_results1_ieee.py
python scripts/figures/make_rq3_figure.py
python scripts/figures/make_rq3_memory_gas_figure.py
```

Expected outputs:

- `figures/Architect.pdf`
- `figures/results1_ieee_three_panel.pdf`
- `figures/rq3_ieee_four_panel.pdf`
- `figures/rq3_memory_gas.pdf`

## Benchmark Notes

Run benchmarks sequentially:

1. Start one relayer for one protocol.
2. Run the matching benchmark script.
3. Stop that relayer.
4. Repeat for the next protocol.

This avoids nonce contention, block-space interference, and cross-protocol event noise.

Representative entry points:

```bash
npx hardhat test
npx hardhat test test/xsmart-bc1/XBridgingContract.CommitReveal.test.ts
npx hardhat run --config hardhat.xsmart-bc1.config.ts scripts/benchmark/rq3-memory-gas.ts --network besu
npx hardhat run --config hardhat.xsmart-bc1.config.ts scripts/benchmark/rq3-zk-verifier-gas.ts --network besu
```

The WAN/concurrency RQ4 artifacts are retained under `benchmark-results/rq4/`. These values should be treated as reported VM measurements. Local smoke runs are useful for checking scripts, but should not replace the reported VM results.

## Reproducibility Policy

- Keep reported claims tied to raw JSON/CSV artifacts.
- Regenerate figures from retained result files, not from manually edited values.
- Do not commit generated Hardhat artifacts, TypeChain bindings, Rust targets, local deployments, VM scratch directories, logs, or secrets.
- Keep trusted-adapter measurements separate from stronger production proof-adapter projections.
- Report latency definitions carefully, especially receipt-confirmation latency versus pure execution time.

## Artifact Use

For reproduction, record the exact Git commit hash and keep generated outputs separate from the curated raw artifacts in this repository.
