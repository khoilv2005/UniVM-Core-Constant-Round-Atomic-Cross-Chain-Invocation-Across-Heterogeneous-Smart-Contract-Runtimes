from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.patches import Circle, FancyArrowPatch, FancyBboxPatch, Polygon, Rectangle


ROOT = Path(__file__).resolve().parents[2]
FIG_DIR = ROOT / "figures"
OUT_PDF = FIG_DIR / "Architect.pdf"
OUT_PNG = FIG_DIR / "Architect.png"

INK = "#111827"
TEXT = "#1F2937"
MUTED = "#64748B"
PANEL = "#FBFCFE"
BORDER = "#D7E0EA"
RAIL = "#E2E8F0"
BLUE = "#2563EB"
BLUE_SOFT = "#DBEAFE"
GREEN = "#059669"
GREEN_SOFT = "#D1FAE5"
PURPLE = "#7C3AED"
PURPLE_SOFT = "#EDE9FE"
AMBER = "#D97706"
AMBER_SOFT = "#FEF3C7"
RED = "#DC2626"
RED_SOFT = "#FEE2E2"
WHITE = "#FFFFFF"


def arrow(ax, start, end, color=BLUE, lw=1.35, ms=8, dashed=False, both=False, rad=0.0, z=5):
    ax.add_patch(
        FancyArrowPatch(
            start,
            end,
            arrowstyle="<|-|>" if both else "-|>",
            mutation_scale=ms,
            linewidth=lw,
            color=color,
            linestyle=(0, (3, 2)) if dashed else "solid",
            connectionstyle=f"arc3,rad={rad}",
            shrinkA=2,
            shrinkB=2,
            zorder=z,
        )
    )

def poly_arrow(ax, points, color=BLUE, lw=1.12, ms=8, dashed=False):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    ax.plot(
        xs[:-1],
        ys[:-1],
        color=color,
        lw=lw,
        linestyle=(0, (3, 2)) if dashed else "solid",
        zorder=4,
    )
    arrow(ax, points[-2], points[-1], color=color, lw=lw, ms=ms, dashed=dashed, z=5)


def panel(ax, x, y, w, h, title, subtitle):
    ax.add_patch(
        FancyBboxPatch(
            (x, y),
            w,
            h,
            boxstyle="round,pad=0.012,rounding_size=0.012",
            facecolor=PANEL,
            edgecolor=BORDER,
            linewidth=0.75,
            zorder=1,
        )
    )
    ax.text(x + w / 2, y + h - 0.055, title, ha="center", va="center", fontsize=9.0, fontweight="bold", color=INK, zorder=2)
    ax.text(x + w / 2, y + h - 0.092, subtitle, ha="center", va="center", fontsize=6.7, color=MUTED, zorder=2)


def middleware_panel(ax, x, y, w, h):
    ax.add_patch(
        FancyBboxPatch(
            (x, y),
            w,
            h,
            boxstyle="round,pad=0.014,rounding_size=0.014",
            facecolor="#FBFDFF",
            edgecolor="#CBD5E1",
            linewidth=0.75,
            zorder=1,
        )
    )
    ax.add_patch(
        FancyBboxPatch(
            (x + 0.018, y + h - 0.072),
            w - 0.036,
            0.050,
            boxstyle="round,pad=0.006,rounding_size=0.010",
            facecolor="#EEF6FF",
            edgecolor="none",
            zorder=2,
        )
    )
    ax.text(x + w / 2, y + h - 0.047, "UniVM-Core Middleware", ha="center", va="center", fontsize=9.4, fontweight="bold", color=INK, zorder=3)


def mini_symbol(ax, x, y, kind, color=TEXT, scale=1.0, z=8):
    if kind == "lock":
        ax.add_patch(Rectangle((x - 0.010 * scale, y - 0.009 * scale), 0.020 * scale, 0.014 * scale, facecolor="none", edgecolor=color, lw=0.9, zorder=z))
        ax.add_patch(FancyArrowPatch((x - 0.007 * scale, y + 0.004 * scale), (x + 0.007 * scale, y + 0.004 * scale), connectionstyle="arc3,rad=-0.85", arrowstyle="-", color=color, lw=0.9, zorder=z))
    elif kind == "ack":
        arrow(ax, (x + 0.012 * scale, y + 0.006 * scale), (x - 0.010 * scale, y + 0.006 * scale), color=color, lw=0.9, ms=5, z=z)
        ax.plot([x - 0.010 * scale, x + 0.010 * scale, x + 0.010 * scale], [y + 0.006 * scale, y + 0.006 * scale, y - 0.008 * scale], color=color, lw=0.9, zorder=z)
    elif kind == "guard":
        ax.add_patch(Polygon([(x, y + 0.014 * scale), (x + 0.012 * scale, y + 0.007 * scale), (x + 0.009 * scale, y - 0.010 * scale), (x, y - 0.017 * scale), (x - 0.009 * scale, y - 0.010 * scale), (x - 0.012 * scale, y + 0.007 * scale)], closed=True, facecolor="none", edgecolor=color, lw=0.9, zorder=z))
    elif kind == "registry":
        for dy in [0.008, 0.000, -0.008]:
            ax.add_patch(Rectangle((x - 0.012 * scale, y + dy * scale - 0.004 * scale), 0.024 * scale, 0.006 * scale, facecolor="none", edgecolor=color, lw=0.85, zorder=z))
    elif kind == "contract":
        ax.add_patch(Rectangle((x - 0.010 * scale, y - 0.014 * scale), 0.020 * scale, 0.028 * scale, facecolor="none", edgecolor=color, lw=0.85, zorder=z))
        ax.plot([x - 0.006 * scale, x + 0.006 * scale], [y + 0.005 * scale, y + 0.005 * scale], color=color, lw=0.75, zorder=z)
        ax.plot([x - 0.006 * scale, x + 0.006 * scale], [y - 0.003 * scale, y - 0.003 * scale], color=color, lw=0.75, zorder=z)
    elif kind == "tx":
        ax.add_patch(Polygon([(x, y + 0.014 * scale), (x + 0.013 * scale, y + 0.006 * scale), (x + 0.013 * scale, y - 0.006 * scale), (x, y - 0.014 * scale), (x - 0.013 * scale, y - 0.006 * scale), (x - 0.013 * scale, y + 0.006 * scale)], closed=True, facecolor="none", edgecolor=color, lw=0.9, zorder=z))
    elif kind == "commit":
        ax.add_patch(Circle((x, y), 0.014 * scale, facecolor="none", edgecolor=color, lw=0.9, zorder=z))
        ax.plot([x - 0.007 * scale, x - 0.002 * scale, x + 0.008 * scale], [y, y - 0.006 * scale, y + 0.007 * scale], color=color, lw=0.9, zorder=z)
    elif kind == "lift":
        doc_icon(ax, x - 0.016 * scale, y - 0.010 * scale, "", 0.46 * scale)
        arrow(ax, (x - 0.001 * scale, y), (x + 0.017 * scale, y), color=color, lw=0.85, ms=5, z=z)
    elif kind == "verify":
        ax.add_patch(Polygon([(x, y + 0.014 * scale), (x + 0.012 * scale, y + 0.007 * scale), (x + 0.009 * scale, y - 0.010 * scale), (x, y - 0.017 * scale), (x - 0.009 * scale, y - 0.010 * scale), (x - 0.012 * scale, y + 0.007 * scale)], closed=True, facecolor="none", edgecolor=color, lw=0.9, zorder=z))
        ax.plot([x - 0.006 * scale, x - 0.001 * scale, x + 0.007 * scale], [y, y - 0.005 * scale, y + 0.006 * scale], color=color, lw=0.9, zorder=z)
    elif kind == "database":
        for yy in [0.009, 0.000, -0.009]:
            ax.add_patch(Rectangle((x - 0.012 * scale, y + yy * scale - 0.004 * scale), 0.024 * scale, 0.006 * scale, facecolor="none", edgecolor=color, lw=0.85, zorder=z))
        arrow(ax, (x - 0.020 * scale, y + 0.014 * scale), (x - 0.006 * scale, y + 0.005 * scale), color=color, lw=0.75, ms=4, z=z)
    elif kind == "ir":
        ax.text(x, y, "IR", ha="center", va="center", fontsize=6.5, color=color, fontweight="bold", zorder=z)
    elif kind == "evm":
        ax.text(x, y, "EVM", ha="center", va="center", fontsize=6.2, color=color, fontweight="bold", zorder=z)
    elif kind == "logic":
        doc_icon(ax, x - 0.010 * scale, y - 0.014 * scale, "L", 0.55 * scale)
        doc_icon(ax, x + 0.004 * scale, y - 0.014 * scale, "S", 0.55 * scale)
    elif kind == "tree":
        ax.plot([x, x], [y - 0.012 * scale, y + 0.006 * scale], color=color, lw=0.9, zorder=z)
        ax.plot([x, x - 0.012 * scale], [y + 0.002 * scale, y + 0.014 * scale], color=color, lw=0.9, zorder=z)
        ax.plot([x, x + 0.012 * scale], [y + 0.002 * scale, y + 0.014 * scale], color=color, lw=0.9, zorder=z)
        ax.add_patch(Circle((x - 0.012 * scale, y + 0.014 * scale), 0.0037 * scale, facecolor=color, edgecolor=color, lw=0.5, zorder=z))
        ax.add_patch(Circle((x + 0.012 * scale, y + 0.014 * scale), 0.0037 * scale, facecolor=color, edgecolor=color, lw=0.5, zorder=z))
        ax.add_patch(Circle((x, y - 0.012 * scale), 0.0037 * scale, facecolor=color, edgecolor=color, lw=0.5, zorder=z))
    else:
        ax.text(x, y, kind, ha="center", va="center", fontsize=6.5, color=color, fontweight="bold", zorder=z)


def node(ax, x, y, n, title, subtitle, color, fill, icon=None, r=0.026):
    ax.add_patch(Circle((x, y), r, facecolor=fill, edgecolor=color, lw=1.2, zorder=6))
    ax.text(x, y + 0.001, str(n), ha="center", va="center", fontsize=7.0, fontweight="bold", color=color, zorder=7)
    if icon:
        mini_symbol(ax, x, y + r + 0.020, icon, color=color, scale=0.82, z=7)
    ax.text(x, y - r - 0.017, title, ha="center", va="center", fontsize=6.4, fontweight="bold", color=TEXT, zorder=7)
    ax.text(x, y - r - 0.039, subtitle, ha="center", va="center", fontsize=5.6, color=MUTED, zorder=7)


def badge(ax, x, y, w, h, text, color=PURPLE, fill=PURPLE_SOFT, fs=5.9, dashed=False, seal=False):
    ax.add_patch(
        FancyBboxPatch(
            (x, y),
            w,
            h,
            boxstyle="round,pad=0.008,rounding_size=0.010",
            facecolor=fill,
            edgecolor=color,
            linewidth=0.8,
            linestyle=(0, (3, 2)) if dashed else "solid",
            zorder=4,
        )
    )
    if seal:
        ax.add_patch(Circle((x + 0.026, y + h / 2), 0.014, facecolor=WHITE, edgecolor=color, lw=0.8, zorder=6))
        ax.plot([x + 0.020, x + 0.024, x + 0.032], [y + h / 2, y + h / 2 - 0.005, y + h / 2 + 0.006], color=color, lw=0.9, zorder=7)
        ax.text(x + 0.046, y + h / 2, text, ha="left", va="center", fontsize=fs, color=TEXT, linespacing=1.05, zorder=6)
    else:
        ax.text(x + w / 2, y + h / 2, text, ha="center", va="center", fontsize=fs, color=TEXT, linespacing=1.05, zorder=6)


def stack_item(ax, x, y, icon, text, color=TEXT):
    mini_symbol(ax, x, y, icon, color=color, scale=0.88, z=5)
    ax.text(x + 0.030, y, text, ha="left", va="center", fontsize=6.6, color=TEXT, zorder=5)


def doc_icon(ax, x, y, label, scale=1.0):
    w, h = 0.018 * scale, 0.028 * scale
    fold = 0.0055 * scale
    ax.add_patch(Rectangle((x, y), w, h, facecolor=WHITE, edgecolor=INK, lw=0.85, zorder=8))
    ax.add_patch(Polygon([(x + w - fold, y + h), (x + w, y + h - fold), (x + w - fold, y + h - fold)], facecolor="#E5E7EB", edgecolor=INK, lw=0.55, zorder=9))
    ax.text(x + w / 2, y + h * 0.36, label, ha="center", va="center", fontsize=4.9, fontweight="bold", zorder=10)


def relayers(ax, x, y, scale=1.0):
    for dx, dy in [(-0.011, 0.0), (0.0, 0.007), (0.011, 0.0)]:
        ax.add_patch(Circle((x + dx * scale, y + dy * scale + 0.012 * scale), 0.0055 * scale, facecolor=INK, edgecolor=INK, lw=0.4, zorder=8))
        ax.add_patch(Rectangle((x + dx * scale - 0.008 * scale, y + dy * scale), 0.016 * scale, 0.010 * scale, facecolor=INK, edgecolor=INK, lw=0.4, zorder=8))


def main():
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans"],
            "font.size": 8,
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
            "figure.dpi": 300,
        }
    )

    fig, ax = plt.subplots(figsize=(7.16, 3.64))
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")
    fig.subplots_adjust(left=0.014, right=0.986, top=0.982, bottom=0.024)

    # Three zones.
    panel(ax, 0.035, 0.165, 0.185, 0.695, "Invoked Chains", "WASM Train / Fabric Hotel")
    middleware_panel(ax, 0.265, 0.150, 0.470, 0.720)
    panel(ax, 0.780, 0.165, 0.185, 0.695, "Execution Chain", "Agency / bc_e")

    # Left chain as compact stack, not boxes.
    ax.text(0.070, 0.705, "Native logic-state contracts", ha="left", va="center", fontsize=7.0, fontweight="bold", color=TEXT)
    doc_icon(ax, 0.070, 0.650, "L", 0.92)
    doc_icon(ax, 0.101, 0.650, "S", 0.92)
    ax.text(0.145, 0.666, "logic + state", ha="left", va="center", fontsize=6.3, color=TEXT)
    stack_item(ax, 0.083, 0.558, "lock", "Locked evidence", GREEN)
    stack_item(ax, 0.083, 0.482, "ack", "Update / ACK", AMBER)
    stack_item(ax, 0.083, 0.405, "guard", "Bridge guard", MUTED)

    # Right chain as runtime stack.
    ax.text(0.815, 0.705, "EVM on-chain runtime", ha="left", va="center", fontsize=7.0, fontweight="bold", color=TEXT)
    stack_item(ax, 0.828, 0.630, "registry", "UCTLRegistry", AMBER)
    stack_item(ax, 0.828, 0.552, "contract", "UniVMBridgeContract", BLUE)
    stack_item(ax, 0.828, 0.474, "tx", "Integrated EVM tx", BLUE)
    stack_item(ax, 0.828, 0.396, "commit", "Commit emission", AMBER)

    # Translation rail.
    ax.text(0.298, 0.765, "A. Translation Plane", ha="left", va="center", fontsize=7.6, fontweight="bold", color=INK)
    ax.text(0.298, 0.735, "source → IR → verification → clone", ha="left", va="center", fontsize=6.2, color=MUTED)
    y_t = 0.640
    xs_t = [0.330, 0.432, 0.534, 0.636]
    ax.plot([xs_t[0], xs_t[-1]], [y_t, y_t], color=BLUE_SOFT, lw=4.0, solid_capstyle="round", zorder=2)
    for a, b in zip(xs_t[:-1], xs_t[1:]):
        arrow(ax, (a + 0.030, y_t), (b - 0.030, y_t), color=BLUE, lw=0.9, ms=6, z=3)
    node(ax, xs_t[0], y_t, 1, "Lift", "frontend", BLUE, BLUE_SOFT, icon="lift")
    node(ax, xs_t[1], y_t, 2, "Typed IR", "H_sem", GREEN, GREEN_SOFT, icon="ir")
    node(ax, xs_t[2], y_t, 3, "Verify", "safe subset", PURPLE, PURPLE_SOFT, icon="verify")
    node(ax, xs_t[3], y_t, 4, "Clone", "EVM backend", AMBER, AMBER_SOFT, icon="evm")
    badge(ax, 0.322, 0.482, 0.356, 0.052, "Certified clone\nsource hash · IR hash · storage-map root · clone address", PURPLE, AMBER_SOFT, fs=5.25, dashed=True, seal=True)

    # Execution rail.
    ax.text(0.298, 0.415, "B. Execution Plane", ha="left", va="center", fontsize=7.6, fontweight="bold", color=INK)
    ax.text(0.298, 0.386, "proof-backed state import and call-tree execution", ha="left", va="center", fontsize=6.2, color=MUTED)
    y_e = 0.300
    xs_e = [0.330, 0.432, 0.534, 0.636]
    ax.plot([xs_e[0], xs_e[-1]], [y_e, y_e], color=GREEN_SOFT, lw=4.0, solid_capstyle="round", zorder=2)
    for a, b in zip(xs_e[:-1], xs_e[1:]):
        arrow(ax, (a + 0.030, y_e), (b - 0.030, y_e), color=GREEN, lw=0.9, ms=6, z=3)
    node(ax, xs_e[0], y_e, 5, "Proof", "check", PURPLE, PURPLE_SOFT, icon="verify")
    node(ax, xs_e[1], y_e, 6, "VASSP", "E(σ)", GREEN, GREEN_SOFT, icon="database")
    node(ax, xs_e[2], y_e, 7, "CallTree", "execute", BLUE, BLUE_SOFT, icon="tree")
    node(ax, xs_e[3], y_e, 8, "Commit", "+ update/ACK", AMBER, AMBER_SOFT, icon="commit")
    badge(ax, 0.338, 0.170, 0.324, 0.048, "Atomic boundary: lock manifest → CommitDecided → ACK retry", AMBER, AMBER_SOFT, fs=5.55)

    # Inter-zone bridge flows.
    arrow(ax, (0.220, 0.650), (0.300, y_t), color=BLUE, lw=1.35, ms=9, rad=0.04)
    arrow(ax, (0.666, y_t), (0.780, 0.630), color=AMBER, lw=1.35, ms=9, rad=-0.05)
    ax.text(0.247, 0.694, "source logic", ha="center", va="center", fontsize=5.9, color=MUTED)
    ax.text(0.728, 0.684, "translated clone", ha="center", va="center", fontsize=5.9, color=MUTED)

    arrow(ax, (0.220, 0.558), (0.300, y_e), color=GREEN, lw=1.35, ms=9, rad=-0.08)
    arrow(ax, (0.666, y_e), (0.780, 0.474), color=BLUE, lw=1.35, ms=9, rad=0.08)
    poly_arrow(ax, [(0.780, 0.396), (0.735, 0.145), (0.250, 0.145), (0.220, 0.482)], color=AMBER, lw=1.05, ms=8, dashed=True)
    ax.text(0.264, 0.522, "lock/evidence", ha="center", va="center", fontsize=5.9, color=MUTED)
    ax.text(0.722, 0.435, "execute", ha="center", va="center", fontsize=5.9, color=MUTED)

    # Limitation note.
    badge(
        ax,
        0.248,
        0.062,
        0.504,
        0.038,
        "Scope: static locks · deterministic call trees · sound adapters",
        RED,
        RED_SOFT,
        fs=5.5,
        dashed=True,
    )

    fig.savefig(OUT_PDF, bbox_inches="tight", pad_inches=0.018)
    fig.savefig(OUT_PNG, bbox_inches="tight", pad_inches=0.018, dpi=300)
    plt.close(fig)
    print(f"Wrote {OUT_PDF}")
    print(f"Wrote {OUT_PNG}")


if __name__ == "__main__":
    main()
