import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


ROOT = Path(__file__).resolve().parents[2]
RESULT_PATH = ROOT / "benchmark-results" / "rq3" / "translation-overhead-besu.json"
FIG_DIR = ROOT / "figures"
FIG_DIR.mkdir(exist_ok=True)

VARIANTS = [
    ("handwritten", "Handwritten", "#0072B2"),
    ("translated_naive", "Naive", "#D55E00"),
    ("translated_optimized", "Optimized", "#009E73"),
]


def load_results():
    with RESULT_PATH.open("r", encoding="utf-8") as f:
        data = json.load(f)
    summary = data["summary"]
    levels = data["levels"]
    by_key = {
        (entry["variant"], entry["complexitySlots"]): entry
        for entry in summary
    }
    return data, levels, by_key


def style_axis(ax):
    ax.grid(axis="y", color="#D9D9D9", linewidth=0.55)
    ax.set_axisbelow(True)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_linewidth(0.8)
    ax.spines["bottom"].set_linewidth(0.8)
    ax.tick_params(axis="both", labelsize=8, width=0.8, length=3)


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

    data, levels, by_key = load_results()
    x = np.arange(len(levels))
    width = 0.24
    offsets = np.linspace(-width, width, len(VARIANTS))

    fig, ax = plt.subplots(1, 1, figsize=(3.05, 2.10))

    for offset, (variant, label, color) in zip(offsets, VARIANTS):
        gas_k = [by_key[(variant, level)]["avgExecutionGas"] / 1000 for level in levels]
        ax.bar(
            x + offset,
            gas_k,
            width=width,
            color=color,
            edgecolor="#333333",
            linewidth=0.35,
            label=label,
        )

    ax.set_xlabel("Logical storage slots", labelpad=6)
    ax.set_ylabel("Execution gas (K)")
    ax.set_xticks(x)
    ax.set_xticklabels([str(level) for level in levels])
    ax.set_ylim(0, 430)
    style_axis(ax)

    ax.legend(
        loc="upper center",
        ncol=3,
        frameon=False,
        bbox_to_anchor=(0.5, 1.16),
        columnspacing=0.8,
        handlelength=1.1,
        handletextpad=0.35,
        fontsize=7.2,
    )
    fig.subplots_adjust(left=0.18, right=0.99, top=0.80, bottom=0.28)

    png_path = FIG_DIR / "rq3d_translation_overhead.png"
    pdf_path = FIG_DIR / "rq3d_translation_overhead.pdf"
    fig.savefig(png_path, dpi=600)
    fig.savefig(pdf_path)
    print(f"Saved {png_path}")
    print(f"Saved {pdf_path}")


if __name__ == "__main__":
    main()
