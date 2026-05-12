import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
RESULT_PATH = ROOT / "benchmark-results" / "rq3" / "memory-gas.json"
FIG_DIR = ROOT / "figures"
FIG_DIR.mkdir(exist_ok=True)

METHODS = [
    ("decode", "Decode", "#0072B2"),
    ("execute", "Scan execute", "#009E73"),
    ("total", "Storage import", "#D55E00"),
]


def load_results():
    with RESULT_PATH.open("r", encoding="utf-8") as f:
        data = json.load(f)
    by_key = {(row["method"], row["sizeKiB"]): row for row in data["summary"]}
    return data, data["sizesKiB"], by_key


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
            "legend.fontsize": 7.4,
            "xtick.labelsize": 8,
            "ytick.labelsize": 8,
        }
    )

    data, sizes, by_key = load_results()
    fig, ax = plt.subplots(1, 1, figsize=(3.35, 2.25))

    for method, label, color in METHODS:
        xs_ok = []
        ys_ok = []
        xs_fail = []
        for size in sizes:
            row = by_key[(method, size)]
            if row["avgGas"] is not None:
                xs_ok.append(size)
                ys_ok.append(row["avgGas"] / 1_000_000)
        ax.plot(xs_ok, ys_ok, marker="o", markersize=3.0, linewidth=1.25, color=color, label=label)

    threshold = data["threshold"]
    fitted = threshold.get("fittedMaxBytesAtBlockLimit")
    if fitted:
        fitted_kib = fitted / 1024
        slope = threshold.get("slopeGasPerByte")
        intercept = threshold.get("interceptGas")
        if slope and intercept:
            ok_total = [
                (size, by_key[("total", size)]["avgGas"] / 1_000_000)
                for size in sizes
                if by_key[("total", size)]["avgGas"] is not None
            ]
            if ok_total:
                start_kib = ok_total[-1][0]
                xs_fit = np.linspace(start_kib, fitted_kib, 20)
                ys_fit = [(intercept + slope * x * 1024) / 1_000_000 for x in xs_fit]
                ax.plot(xs_fit, ys_fit, linestyle="--", linewidth=1.0, color="#D55E00", alpha=0.85)
        ax.axvline(fitted_kib, color="#555555", linestyle="--", linewidth=0.8)
        ax.text(
            fitted_kib + 1.0,
            16.0,
            f"$B_{{max}}$={fitted_kib:.1f} KiB",
            rotation=90,
            va="center",
            ha="left",
            fontsize=6.8,
            color="#444444",
        )

    ax.axhline(30, color="#999999", linestyle=":", linewidth=0.8)
    ax.text(1.1, 30.7, "30M gas limit", fontsize=6.8, color="#555555")
    ax.set_xlabel("Canonical payload size (KiB)", labelpad=5)
    ax.set_ylabel("Gas consumed (M)")
    ax.set_xscale("log", base=2)
    ax.set_xticks(sizes)
    ax.set_xticklabels([str(s) for s in sizes])
    ax.set_ylim(0, 32)
    style_axis(ax)
    ax.legend(
        loc="upper center",
        bbox_to_anchor=(0.5, 1.24),
        ncol=3,
        frameon=False,
        handlelength=1.2,
        handletextpad=0.35,
        columnspacing=0.9,
    )
    fig.subplots_adjust(left=0.17, right=0.98, top=0.78, bottom=0.24)

    png_path = FIG_DIR / "rq3_memory_gas.png"
    pdf_path = FIG_DIR / "rq3_memory_gas.pdf"
    fig.savefig(png_path, dpi=600)
    fig.savefig(pdf_path)
    print(f"Saved {png_path}")
    print(f"Saved {pdf_path}")


if __name__ == "__main__":
    main()
