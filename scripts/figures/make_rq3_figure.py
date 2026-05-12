import json
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
import numpy as np


ROOT = Path(__file__).resolve().parents[2]
RESULT_DIR = ROOT / "benchmark-results" / "rq3"
TRANSLATION_RESULT_PATH = RESULT_DIR / "translation-overhead-besu.json"
FIG_DIR = ROOT / "figures"
FIG_DIR.mkdir(exist_ok=True)

PROTOCOLS = [
    ("xsmart", "UniVM-Core"),
    ("integratex", "IntegrateX"),
    ("atom", "AtomCI"),
    ("gpact", "GPACT"),
]

COLORS = {
    "xsmart": "#0072B2",
    "integratex": "#E69F00",
    "atom": "#CC79A7",
    "gpact": "#009E73",
}

TRANSLATION_VARIANTS = [
    ("handwritten", "Handwritten", "#0072B2"),
    ("translated_naive", "Naive", "#D55E00"),
    ("translated_optimized", "Optimized", "#009E73"),
]


def protocol_line_handles():
    return [
        Line2D(
            [0],
            [0],
            color=COLORS[protocol],
            marker="o",
            markersize=3.8,
            linewidth=1.35,
            label=label,
        )
        for protocol, label in PROTOCOLS
    ]


def protocol_patch_handles():
    return [
        Patch(
            facecolor=COLORS[protocol],
            edgecolor="#333333",
            linewidth=0.35,
            label=label,
        )
        for protocol, label in PROTOCOLS
    ]


def translation_patch_handles():
    return [
        Patch(
            facecolor=color,
            edgecolor="#333333",
            linewidth=0.35,
            label=label,
        )
        for _variant, label, color in TRANSLATION_VARIANTS
    ]


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_translation_results():
    data = load_json(TRANSLATION_RESULT_PATH)
    levels = data["levels"]
    by_key = {
        (entry["variant"], entry["complexitySlots"]): entry
        for entry in data["summary"]
    }
    return levels, by_key


def rq3a_throughput(protocol: str, depth: int) -> float:
    data = load_json(RESULT_DIR / f"throughput-{protocol}-d{depth}.json")
    return data["summary"]["throughputCompletedPerMinute"]


def mean(values):
    return sum(values) / len(values) if values else 0.0


def sample_std(values):
    if len(values) <= 1:
        return 0.0
    avg = mean(values)
    return float(np.sqrt(sum((value - avg) ** 2 for value in values) / (len(values) - 1)))


def ci95(values):
    if len(values) <= 1:
        return 0.0
    return 1.96 * sample_std(values) / np.sqrt(len(values))


def rq3a_throughput_with_ci(protocol: str, depth: int):
    repeated = sorted(RESULT_DIR.glob(f"throughput-{protocol}-d{depth}-window*.json"))
    if repeated:
        values = [
            load_json(path)["summary"]["throughputCompletedPerMinute"]
            for path in repeated
        ]
        return mean(values), ci95(values)
    return rq3a_throughput(protocol, depth), 0.0


def rq3b_total_gas(protocol: str, depth: int) -> float:
    data = load_json(RESULT_DIR / f"gas-{protocol}-d{depth}.json")
    return data["summary"]["avgTotalGas"] / 1_000_000


def rq3c_median_latency(protocol: str, concurrency: int) -> float:
    data = load_json(RESULT_DIR / f"concurrency-{protocol}-d3-c{concurrency}.json")
    return data["summary"]["medianCompletionLatencySeconds"]


def rq3c_median_latency_with_ci(protocol: str, concurrency: int):
    repeated_dir = RESULT_DIR / "repeated"
    repeated = sorted(repeated_dir.glob(f"concurrency-{protocol}-d3-c{concurrency}-r*.json"))
    if repeated:
        values = [
            load_json(path)["summary"]["medianCompletionLatencySeconds"]
            for path in repeated
        ]
        return mean(values), ci95(values)
    return rq3c_median_latency(protocol, concurrency), 0.0


def rq3c_repeated_c10_stats(protocol: str):
    repeated_dir = RESULT_DIR / "repeated"
    repeated = sorted(repeated_dir.glob(f"concurrency-{protocol}-d3-c10-r*.json"))
    if not repeated:
        return rq3c_median_latency(protocol, 10), 0.0
    values = [
        load_json(path)["summary"]["medianCompletionLatencySeconds"]
        for path in repeated
    ]
    return mean(values), ci95(values)


def style_axis(ax):
    ax.grid(axis="y", color="#D9D9D9", linewidth=0.55)
    ax.set_axisbelow(True)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_linewidth(0.8)
    ax.spines["bottom"].set_linewidth(0.8)
    ax.tick_params(axis="both", labelsize=8, width=0.8, length=3)


def add_panel_caption(ax, caption: str, y: float = -0.32):
    ax.text(
        0.5,
        y,
        caption,
        transform=ax.transAxes,
        ha="center",
        va="top",
        fontsize=8.5,
        fontweight="bold",
    )


def make_four_panel_figure():
    fig, axes = plt.subplots(2, 2, figsize=(7.25, 4.45))
    ax_a, ax_b, ax_c, ax_d = axes.ravel()

    depths_a = [2, 3, 4, 5]
    for protocol, label in PROTOCOLS:
        y = [rq3a_throughput_with_ci(protocol, d)[0] for d in depths_a]
        ax_a.plot(
            depths_a,
            y,
            marker="o",
            markersize=3.8,
            linewidth=1.35,
            color=COLORS[protocol],
            label=label,
        )
    ax_a.set_xlabel("Depth", labelpad=2)
    ax_a.set_ylabel("Throughput (req/min)")
    ax_a.set_xticks(depths_a)
    ax_a.set_ylim(0, 2.8)
    style_axis(ax_a)
    add_panel_caption(ax_a, "(a) RQ3a: Sustained throughput across call depth.")

    depths_b = [2, 3, 4]
    x_b = np.arange(len(depths_b))
    width_b = 0.19
    offsets_b = np.linspace(-1.5 * width_b, 1.5 * width_b, len(PROTOCOLS))
    for offset, (protocol, label) in zip(offsets_b, PROTOCOLS):
        y = [rq3b_total_gas(protocol, d) for d in depths_b]
        ax_b.bar(
            x_b + offset,
            y,
            width=width_b,
            color=COLORS[protocol],
            edgecolor="#333333",
            linewidth=0.35,
            label=label,
        )
    ax_b.set_xlabel("Depth", labelpad=2)
    ax_b.set_ylabel("Gas (million)")
    ax_b.set_xticks(x_b)
    ax_b.set_xticklabels([str(d) for d in depths_b])
    ax_b.set_ylim(0, 2.6)
    style_axis(ax_b)
    add_panel_caption(ax_b, "(b) RQ3b: Participating EVM chain gas.")

    x_c = np.arange(len(PROTOCOLS))
    y_c = [rq3c_repeated_c10_stats(protocol)[0] for protocol, _label in PROTOCOLS]
    ax_c.bar(
        x_c,
        y_c,
        width=0.62,
        color=[COLORS[protocol] for protocol, _label in PROTOCOLS],
        edgecolor="#333333",
        linewidth=0.35,
    )
    ax_c.set_ylabel("Latency (s)")
    ax_c.set_xlabel("Protocol", labelpad=8)
    ax_c.set_xticks(x_c)
    ax_c.set_xticklabels([label for _protocol, label in PROTOCOLS], color="white")
    ax_c.tick_params(axis="x", length=3)
    ax_c.set_ylim(0, 280)
    style_axis(ax_c)
    add_panel_caption(ax_c, "(c) RQ3c: Repeated high-contention median latency (c=10).", y=-0.43)

    levels, by_key = load_translation_results()
    x_d = np.arange(len(levels))
    width_d = 0.24
    offsets_d = np.linspace(-width_d, width_d, len(TRANSLATION_VARIANTS))
    for offset, (variant, label, color) in zip(offsets_d, TRANSLATION_VARIANTS):
        gas_k = [by_key[(variant, level)]["avgExecutionGas"] / 1000 for level in levels]
        ax_d.bar(
            x_d + offset,
            gas_k,
            width=width_d,
            color=color,
            edgecolor="#333333",
            linewidth=0.35,
            label=label,
        )
    ax_d.set_xlabel("Logical storage slots", labelpad=8)
    ax_d.set_ylabel("Execution gas (K)")
    ax_d.set_xticks(x_d)
    ax_d.set_xticklabels([str(level) for level in levels])
    ax_d.set_ylim(0, 430)
    style_axis(ax_d)
    ax_d.legend(
        handles=translation_patch_handles(),
        loc="upper center",
        ncol=3,
        frameon=False,
        bbox_to_anchor=(0.5, 1.18),
        columnspacing=0.8,
        handlelength=1.1,
        handletextpad=0.35,
        fontsize=7.2,
    )
    add_panel_caption(ax_d, "(d) RQ3d: Translated code overhead.", y=-0.43)

    fig.legend(
        handles=protocol_patch_handles(),
        loc="upper center",
        ncol=4,
        frameon=False,
        bbox_to_anchor=(0.5, 0.995),
        columnspacing=1.2,
        handlelength=1.5,
        handletextpad=0.35,
    )
    fig.subplots_adjust(left=0.085, right=0.995, top=0.86, bottom=0.17, wspace=0.36, hspace=0.72)

    png_path = FIG_DIR / "rq3_ieee_four_panel.png"
    pdf_path = FIG_DIR / "rq3_ieee_four_panel.pdf"
    fig.savefig(png_path, dpi=600)
    fig.savefig(pdf_path)
    print(f"Saved {png_path}")
    print(f"Saved {pdf_path}")
    plt.close(fig)


def main():
    plt.rcParams.update(
        {
            "font.family": "serif",
            "font.serif": ["Times New Roman", "Times", "DejaVu Serif"],
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
            "axes.labelsize": 8.5,
            "legend.fontsize": 8,
            "xtick.labelsize": 8,
            "ytick.labelsize": 8,
        }
    )

    make_four_panel_figure()
    make_individual_figures()
    return

    fig, axes = plt.subplots(1, 3, figsize=(7.25, 2.5))
    ax_a, ax_b, ax_c = axes

    # RQ3a: throughput vs depth.
    depths_a = [2, 3, 4, 5]
    for protocol, label in PROTOCOLS:
        y = [rq3a_throughput_with_ci(protocol, d)[0] for d in depths_a]
        ax_a.plot(
            depths_a,
            y,
            marker="o",
            markersize=3.8,
            linewidth=1.35,
            color=COLORS[protocol],
            label=label,
        )
    ax_a.set_xlabel("Depth", labelpad=2)
    ax_a.set_ylabel("Throughput (req/min)")
    ax_a.set_xticks(depths_a)
    ax_a.set_ylim(0, 2.8)
    style_axis(ax_a)

    # RQ3b: all-chain gas vs depth.
    depths_b = [2, 3, 4]
    x = np.arange(len(depths_b))
    width = 0.19
    offsets = np.linspace(-1.5 * width, 1.5 * width, len(PROTOCOLS))
    for offset, (protocol, label) in zip(offsets, PROTOCOLS):
        y = [rq3b_total_gas(protocol, d) for d in depths_b]
        ax_b.bar(
            x + offset,
            y,
            width=width,
            color=COLORS[protocol],
            edgecolor="#333333",
            linewidth=0.35,
            label=label,
        )
    ax_b.set_xlabel("Depth", labelpad=2)
    ax_b.set_ylabel("Gas (million)")
    ax_b.set_xticks(x)
    ax_b.set_xticklabels([str(d) for d in depths_b])
    ax_b.set_ylim(0, 2.6)
    style_axis(ax_b)

    # RQ3c: repeated high-contention c=10 median latency.
    x_c = np.arange(len(PROTOCOLS))
    y = [rq3c_repeated_c10_stats(protocol)[0] for protocol, _label in PROTOCOLS]
    ax_c.bar(
        x_c,
        y,
        width=0.62,
        color=[COLORS[protocol] for protocol, _label in PROTOCOLS],
        edgecolor="#333333",
        linewidth=0.35,
    )
    ax_c.set_ylabel("Latency (s)")
    ax_c.set_xlabel("Protocol", labelpad=12)
    ax_c.set_xticks(x_c)
    ax_c.set_xticklabels([])
    ax_c.tick_params(axis="x", length=0)
    ax_c.set_ylim(0, 280)
    style_axis(ax_c)

    fig.legend(
        protocol_line_handles(),
        [label for _protocol, label in PROTOCOLS],
        loc="upper center",
        ncol=4,
        frameon=False,
        bbox_to_anchor=(0.5, 1.015),
        columnspacing=1.2,
        handlelength=1.5,
        handletextpad=0.35,
    )

    captions = [
        "(a) Throughput vs depth",
        "(b) All-chain gas",
        "(c) Repeated c=10 latency",
    ]
    for ax, caption in zip(axes, captions):
        ax.text(
            0.5,
            -0.36,
            caption,
            transform=ax.transAxes,
            ha="center",
            va="top",
            fontsize=8.5,
            fontweight="bold",
        )

    fig.subplots_adjust(left=0.095, right=0.992, top=0.82, bottom=0.28, wspace=0.40)

    png_path = FIG_DIR / "rq3_ieee_three_panel.png"
    pdf_path = FIG_DIR / "rq3_ieee_three_panel.pdf"
    fig.savefig(png_path, dpi=600)
    fig.savefig(pdf_path)
    print(f"Saved {png_path}")
    print(f"Saved {pdf_path}")

    make_individual_figures()


def save_single(fig, name: str):
    png_path = FIG_DIR / f"{name}.png"
    pdf_path = FIG_DIR / f"{name}.pdf"
    fig.savefig(png_path, dpi=600)
    fig.savefig(pdf_path)
    print(f"Saved {png_path}")
    print(f"Saved {pdf_path}")


def make_individual_figures():
    depths_a = [2, 3, 4, 5]
    single_size = (3.05, 2.10)
    fig_a, ax_a = plt.subplots(1, 1, figsize=single_size)
    for protocol, label in PROTOCOLS:
        y = [rq3a_throughput_with_ci(protocol, d)[0] for d in depths_a]
        ax_a.plot(
            depths_a,
            y,
            marker="o",
            markersize=3.8,
            linewidth=1.35,
            color=COLORS[protocol],
            label=label,
        )
    ax_a.set_xlabel("Depth", labelpad=2)
    ax_a.set_ylabel("Throughput (req/min)")
    ax_a.set_xticks(depths_a)
    ax_a.set_ylim(0, 2.8)
    style_axis(ax_a)
    ax_a.legend(
        handles=protocol_line_handles(),
        loc="upper center",
        ncol=2,
        frameon=False,
        bbox_to_anchor=(0.5, 1.28),
    )
    fig_a.subplots_adjust(left=0.19, right=0.98, top=0.76, bottom=0.22)
    save_single(fig_a, "rq3a_throughput_vs_depth")
    plt.close(fig_a)

    depths_b = [2, 3, 4]
    x = np.arange(len(depths_b))
    width = 0.19
    offsets = np.linspace(-1.5 * width, 1.5 * width, len(PROTOCOLS))
    fig_b, ax_b = plt.subplots(1, 1, figsize=single_size)
    for offset, (protocol, label) in zip(offsets, PROTOCOLS):
        y = [rq3b_total_gas(protocol, d) for d in depths_b]
        ax_b.bar(
            x + offset,
            y,
            width=width,
            color=COLORS[protocol],
            edgecolor="#333333",
            linewidth=0.35,
            label=label,
        )
    ax_b.set_xlabel("Depth", labelpad=2)
    ax_b.set_ylabel("Gas (million)")
    ax_b.set_xticks(x)
    ax_b.set_xticklabels([str(d) for d in depths_b])
    ax_b.set_ylim(0, 2.6)
    style_axis(ax_b)
    ax_b.legend(loc="upper center", ncol=2, frameon=False, bbox_to_anchor=(0.5, 1.28))
    fig_b.subplots_adjust(left=0.19, right=0.98, top=0.76, bottom=0.22)
    save_single(fig_b, "rq3b_all_chain_gas")
    plt.close(fig_b)

    fig_c, ax_c = plt.subplots(1, 1, figsize=single_size)
    x_c = np.arange(len(PROTOCOLS))
    y = [rq3c_repeated_c10_stats(protocol)[0] for protocol, _label in PROTOCOLS]
    ax_c.bar(
        x_c,
        y,
        width=0.62,
        color=[COLORS[protocol] for protocol, _label in PROTOCOLS],
        edgecolor="#333333",
        linewidth=0.35,
    )
    ax_c.set_ylabel("Latency (s)")
    ax_c.set_xlabel("Protocol", labelpad=6)
    ax_c.set_xticks(x_c)
    ax_c.set_xticklabels([])
    ax_c.tick_params(axis="x", length=0)
    ax_c.set_ylim(0, 280)
    style_axis(ax_c)
    ax_c.legend(
        handles=protocol_patch_handles(),
        loc="upper center",
        ncol=4,
        frameon=False,
        bbox_to_anchor=(0.5, 1.16),
        columnspacing=0.55,
        handlelength=0.9,
        handletextpad=0.25,
        fontsize=7.2,
    )
    fig_c.subplots_adjust(left=0.18, right=0.99, top=0.80, bottom=0.28)
    save_single(fig_c, "rq3c_concurrency_latency")
    plt.close(fig_c)


if __name__ == "__main__":
    main()
