import csv
import json
import math
from io import StringIO
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / "RESULTS.md"
OUT_DIR = ROOT / "figures"
OUT_PNG = OUT_DIR / "results1_ieee_three_panel.png"
OUT_PDF = OUT_DIR / "results1_ieee_three_panel.pdf"

PROTOCOL_ORDER = ["UniVM-Core", "IntegrateX", "ATOM", "GPACT"]
LABELS = {
    "UniVM-Core": "UniVM-Core",
    "IntegrateX": "IntegrateX",
    "GPACT": "GPACT",
    "ATOM": "AtomCI",
}

STYLES = {
    "UniVM-Core": {"facecolor": "#0072B2", "edgecolor": "#00466E", "hatch": ""},
    "IntegrateX": {"facecolor": "#E69F00", "edgecolor": "#8F6300", "hatch": ""},
    "ATOM": {"facecolor": "#CC79A7", "edgecolor": "#7F4A68", "hatch": ""},
    "GPACT": {"facecolor": "#009E73", "edgecolor": "#006248", "hatch": ""},
}


def parse_float(value):
    value = value.strip()
    if value.upper() == "N/A":
        return math.nan
    return float(value)


def parse_results():
    rows = []
    for line in RESULTS.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or stripped.startswith("|---"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if not cells or cells[0] == "Experiment":
            continue
        if len(cells) < 8 or cells[0] not in {"1a", "1b", "RQ1a", "RQ1b"}:
            continue
        experiment = {"RQ1a": "1a", "RQ1b": "1b"}.get(cells[0], cells[0])
        protocol = {"AtomCI": "ATOM", "XSmartContract": "UniVM-Core", "XSmart": "UniVM-Core"}.get(cells[1], cells[1])
        rows.append(
            {
                "experiment": experiment,
                "protocol": protocol,
                "scenario": cells[2],
                "runs": cells[3],
                "mean": parse_float(cells[4]),
                "median": parse_float(cells[5]),
                "std": parse_float(cells[6]),
                "status": "ok",
                "output": cells[-1],
            }
        )
    return rows


def row_for(rows, experiment, protocol, scenario=None):
    candidates = [
        row
        for row in rows
        if row["experiment"] == experiment
        and row["protocol"] == protocol
        and (scenario is None or row["scenario"] == scenario)
    ]
    return candidates[0] if candidates else None


def rq1b_raw_path(protocol, depth):
    depth = str(depth).replace("d=", "d")
    prefix = {
        "UniVM-Core": "xsmart",
        "IntegrateX": "integratex",
        "ATOM": "atom",
        "GPACT": "gpact",
    }[protocol]
    return ROOT / "benchmark-results" / f"{prefix}-1b-{depth}.json"


def load_json(path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def summary_seconds(path):
    data = load_json(path)
    summary = data.get("summary", {})
    mean = summary.get("avgSeconds")
    if mean is None:
        mean = summary.get("avgMs", 0) / 1000.0
    std = summary.get("stdSeconds")
    if std is None:
        values = [
            sample.get("latencySeconds", sample.get("latencyMs", 0) / 1000.0)
            for sample in data.get("samples", [])
        ]
        if len(values) > 1:
            avg = sum(values) / len(values)
            std = math.sqrt(sum((value - avg) ** 2 for value in values) / (len(values) - 1))
        else:
            std = 0.0
    runs = summary.get("runs", len(data.get("samples", [])))
    ci = 1.96 * std / math.sqrt(runs) if runs else 0.0
    return mean, ci, runs


def draw_bars(ax, x, values, protocols, width=0.68):
    handles = []
    for xi, value, protocol in zip(x, values, protocols):
        style = STYLES[protocol]
        bar = ax.bar(
            xi,
            value,
            width=width,
            linewidth=0.7,
            **style,
        )
        handles.append(bar[0])
    return handles


def configure_axis(ax, ylabel=False):
    ax.grid(axis="y", color="0.88", linewidth=0.45)
    ax.set_axisbelow(True)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_linewidth(0.6)
    ax.spines["bottom"].set_linewidth(0.6)
    ax.tick_params(axis="both", labelsize=7, width=0.6, length=2.5)
    if ylabel:
        ax.set_ylabel("Latency (s)", fontsize=8)


def add_panel_caption(ax, caption):
    ax.text(
        0.5,
        -0.24,
        caption,
        transform=ax.transAxes,
        ha="center",
        va="top",
        fontsize=8,
        fontweight="bold",
    )


def main():
    rows = parse_results()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    plt.rcParams.update(
        {
            "font.family": "serif",
            "font.serif": ["Times New Roman", "Times", "DejaVu Serif"],
            "font.size": 8,
            "axes.linewidth": 0.6,
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
            "figure.dpi": 300,
        }
    )

    fig, axes = plt.subplots(
        1,
        3,
        figsize=(7.16, 2.42),
        gridspec_kw={"width_ratios": [1.0, 1.85, 1.0], "wspace": 0.28},
    )
    fig.subplots_adjust(top=0.83, bottom=0.24)

    # Panel A: RQ1a representative homogeneous EVM workload.
    ax = axes[0]
    protocols_1a = ["UniVM-Core", "IntegrateX", "ATOM", "GPACT"]
    rows_1a = [row_for(rows, "1a", protocol) for protocol in protocols_1a]
    values_1a = [row["mean"] for row in rows_1a]
    draw_bars(ax, np.arange(len(protocols_1a)), values_1a, protocols_1a)
    ax.set_xticks(np.arange(len(protocols_1a)))
    ax.set_xticklabels([])
    ax.set_ylim(0, 48)
    configure_axis(ax, ylabel=True)
    add_panel_caption(ax, "(a) RQ1a: Homogeneous EVM")

    # Panel B: RQ1b depth scalability.
    ax = axes[1]
    depths = ["d=2", "d=3", "d=4", "d=5"]
    protocols_1b = ["UniVM-Core", "IntegrateX", "ATOM", "GPACT"]
    x = np.arange(len(depths))
    width = 0.18
    offsets = np.linspace(-1.5 * width, 1.5 * width, len(protocols_1b))
    for protocol, offset in zip(protocols_1b, offsets):
        vals = []
        for depth in depths:
            row = row_for(rows, "1b", protocol, depth)
            if row is not None:
                vals.append(row["mean"])
            else:
                mean, _ci, _runs = summary_seconds(rq1b_raw_path(protocol, depth))
                vals.append(mean)
        for xi, val in zip(x + offset, vals):
            style = STYLES[protocol]
            ax.bar(
                xi,
                val,
                width=width,
                linewidth=0.7,
                **style,
            )
    ax.set_xticks(x)
    ax.set_xticklabels([depth.replace("d=", "depth=") for depth in depths])
    ax.set_ylim(0, 62)
    configure_axis(ax)
    add_panel_caption(ax, "(b) RQ1b: Scalability")

    # Panel C: RQ1c heterogeneous EVM+WASM+Fabric depth scaling.
    ax = axes[2]
    hetero_files = {
        "UniVM-Core": {
            2: ROOT / "benchmark-results" / "xsmart-zkmechanism-20260503-d2-30-combined.json",
            3: ROOT / "benchmark-results" / "xsmart-zkmechanism-20260503-d3-30.json",
            4: ROOT / "benchmark-results" / "xsmart-zkmechanism-20260503-d4-30.json",
            5: ROOT / "benchmark-results" / "xsmart-zkmechanism-20260503-d5-30.json",
        },
        "ATOM": {
            2: ROOT / "benchmark-results" / "atom-rq1c-full-20260502-d2-30.json",
            3: ROOT / "benchmark-results" / "atom-rq1c-full-20260502-d3-30.json",
            4: ROOT / "benchmark-results" / "atom-rq1c-full-20260502-d4-30.json",
            5: ROOT / "benchmark-results" / "atom-rq1c-full-20260503-d5-30.json",
        },
        "GPACT": {
            2: ROOT / "benchmark-results" / "gpact-rq1c-full-20260502-d2-30.json",
            3: ROOT / "benchmark-results" / "gpact-rq1c-full-20260502-d3-30.json",
            4: ROOT / "benchmark-results" / "gpact-rq1c-full-20260502-d4-30.json",
            5: ROOT / "benchmark-results" / "gpact-rq1c-full-20260503-d5-30.json",
        },
    }
    depths_c = [2, 3, 4, 5]
    panel_c_upper = 0.0
    for protocol in ["UniVM-Core", "ATOM", "GPACT"]:
        means = []
        cis = []
        for depth in depths_c:
            mean, ci, _runs = summary_seconds(hetero_files[protocol][depth])
            means.append(mean)
            cis.append(ci)
        panel_c_upper = max(panel_c_upper, max(mean + ci for mean, ci in zip(means, cis)))
        style = STYLES[protocol]
        ax.errorbar(
            depths_c,
            means,
            yerr=cis,
            marker="o",
            markersize=3.4,
            linewidth=1.2,
            capsize=2,
            color=style["facecolor"],
            markeredgecolor=style["edgecolor"],
            label=LABELS[protocol],
        )
    ax.set_xticks(depths_c)
    ax.set_xticklabels([f"d={depth}" for depth in depths_c])
    ax.set_ylim(0, max(180, math.ceil(panel_c_upper / 10) * 10))
    configure_axis(ax)
    add_panel_caption(ax, "(c) RQ1c: Heterogeneous scaling")

    legend_handles = [
        plt.Rectangle((0, 0), 1, 1, linewidth=0.7, **STYLES[p])
        for p in PROTOCOL_ORDER
    ]
    fig.legend(
        legend_handles,
        [LABELS[p] for p in PROTOCOL_ORDER],
        loc="upper center",
        ncol=4,
        frameon=False,
        fontsize=7.2,
        handlelength=1.2,
        columnspacing=0.9,
        bbox_to_anchor=(0.5, 0.995),
    )

    fig.savefig(OUT_PDF, bbox_inches="tight")
    fig.savefig(OUT_PNG, bbox_inches="tight", dpi=300)
    print(f"Wrote {OUT_PDF}")
    print(f"Wrote {OUT_PNG}")


if __name__ == "__main__":
    main()
