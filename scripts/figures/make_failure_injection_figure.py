import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


ROOT = Path(__file__).resolve().parents[2]
RESULT_DIR = ROOT / "benchmark-results" / "failure-injection"
FIG_DIR = ROOT / "figures"
FIG_DIR.mkdir(exist_ok=True)

CASE_ORDER = ["FI-1", "FI-2", "FI-3", "FI-4", "FI-5", "FI-6"]
RECOVERY_LABELS = {
    "FI-1": "Pre-commit\nrelayer kill",
    "FI-2": "Post-commit\nrelayer kill",
}
CHECK_LABELS = {
    "FI-3": "Malformed\nmessage",
    "FI-4": "Duplicate\nACK",
    "FI-5": "Update\nfailure",
    "FI-6": "Pre-commit\ntimeout",
}


def load_cases():
    rows = []
    for path in sorted(RESULT_DIR.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if "result" in data:
            rows.append({**data["result"], "source": path.name})
        for row in data.get("cases", []):
            rows.append({**row, "source": path.name})
    by_case = {row["caseId"]: row for row in rows}
    return [by_case[case_id] for case_id in CASE_ORDER if case_id in by_case]


def set_style():
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


def style_axis(ax, grid_axis="y"):
    ax.grid(axis=grid_axis, color="#D9D9D9", linewidth=0.55)
    ax.set_axisbelow(True)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_linewidth(0.8)
    ax.spines["bottom"].set_linewidth(0.8)
    ax.tick_params(axis="both", labelsize=8, width=0.8, length=3)


def save(fig, name):
    png_path = FIG_DIR / f"{name}.png"
    pdf_path = FIG_DIR / f"{name}.pdf"
    fig.savefig(png_path, dpi=600, bbox_inches="tight", pad_inches=0.06)
    fig.savefig(pdf_path, bbox_inches="tight", pad_inches=0.06)
    print(f"Saved {png_path}")
    print(f"Saved {pdf_path}")


def make_recovery_figure(cases):
    labels = [RECOVERY_LABELS[row["caseId"]] for row in cases]
    recovery_s = [float(row["recoveryTimeMs"]) / 1000.0 for row in cases]

    fig, ax = plt.subplots(1, 1, figsize=(3.35, 1.9))
    x = np.arange(len(cases))
    bars = ax.bar(
        x,
        recovery_s,
        width=0.58,
        color="#0072B2",
        edgecolor="#333333",
        linewidth=0.45,
    )

    for bar in bars:
        value = bar.get_height()
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            value + 0.35,
            f"{value:.2f}s",
            ha="center",
            va="bottom",
            fontsize=7.8,
        )

    ax.set_ylabel("Recovery time (s)")
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_ylim(0, 16)
    style_axis(ax, "y")
    fig.subplots_adjust(left=0.18, right=0.98, top=0.94, bottom=0.30)
    save(fig, "failure_injection_recovery")
    plt.close(fig)


def make_state_check_figure(cases):
    labels = [CHECK_LABELS[row["caseId"]] for row in cases]
    passed = [row.get("status") == "pass" and row.get("stateConsistent") is True for row in cases]
    values = [1 if ok else 0 for ok in passed]

    fig, ax = plt.subplots(1, 1, figsize=(3.35, 1.9))
    x = np.arange(len(cases))
    bars = ax.bar(
        x,
        values,
        width=0.58,
        color=["#009E73" if ok else "#D55E00" for ok in passed],
        edgecolor="#333333",
        linewidth=0.45,
    )

    for bar, ok in zip(bars, passed):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            0.5,
            "PASS" if ok else "FAIL",
            ha="center",
            va="center",
            fontsize=7.8,
            color="white",
            fontweight="bold",
        )

    ax.set_ylabel("State check")
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_yticks([0, 1])
    ax.set_yticklabels(["fail", "pass"])
    ax.set_ylim(0, 1.15)
    style_axis(ax, "y")
    fig.subplots_adjust(left=0.20, right=0.98, top=0.94, bottom=0.32)
    save(fig, "failure_injection_state_checks")
    plt.close(fig)


def main():
    set_style()
    cases = load_cases()
    recovery_cases = [row for row in cases if row["caseId"] in RECOVERY_LABELS]
    check_cases = [row for row in cases if row["caseId"] in CHECK_LABELS]
    make_recovery_figure(recovery_cases)
    make_state_check_figure(check_cases)


if __name__ == "__main__":
    main()
