"use client";

import { useId, useState } from "react";

/**
 * Single-series line chart (dataviz skill: 2px line, ≥8px end marker with a surface ring,
 * hairline recessive grid, clean y ticks from 0, crosshair + tooltip on hover/focus).
 * One series, so no legend box — the caller's heading names what is plotted. The caller also
 * renders the same data as a table (accessibility), so the SVG itself is presentational.
 */
export interface LinePoint {
  label: string;
  value: number;
  /** Shade this point's slot: the window a health reason points to. */
  highlight?: boolean;
}

const W = 640;
const H = 220;
const PAD = { top: 16, right: 16, bottom: 28, left: 40 };
const SERIES = "#2a78d6"; // reference palette slot 1 (validated against the light surface)

function niceMax(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 4, step: 1 };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  return { top: Math.ceil(max / step) * step, step };
}

export function LineChart({ points, valueLabel }: { points: LinePoint[]; valueLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const { top, step } = niceMax(Math.max(...points.map((p) => p.value)));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) =>
    PAD.left + (points.length === 1 ? innerW / 2 : (i * innerW) / (points.length - 1));
  const y = (v: number) => PAD.top + innerH - (v / top) * innerH;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(" ");
  const last = points.length - 1;
  const active = hover ?? null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-labelledby={titleId}>
        <title
          id={titleId}
        >{`${valueLabel}, ${points.length} weeks. The same data is in the table below.`}</title>
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(t) + 4}
              textAnchor="end"
              fontSize={11}
              fill="var(--muted-foreground)"
            >
              {t >= 1000 ? `${t / 1000}K` : t}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          i % 2 === 0 || i === last ? (
            <text
              key={p.label}
              x={x(i)}
              y={H - 8}
              textAnchor="middle"
              fontSize={11}
              fill="var(--muted-foreground)"
            >
              {p.label}
            </text>
          ) : null,
        )}
        {points.map((p, i) =>
          p.highlight ? (
            <rect
              key={`hl-${p.label}`}
              x={x(i) - innerW / (2 * Math.max(1, points.length - 1))}
              y={PAD.top}
              width={innerW / Math.max(1, points.length - 1)}
              height={innerH}
              fill="var(--muted)"
              data-testid="chart-highlight"
            />
          ) : null,
        )}
        {active !== null ? (
          <line
            x1={x(active)}
            x2={x(active)}
            y1={PAD.top}
            y2={PAD.top + innerH}
            stroke="var(--muted-foreground)"
            strokeWidth={1}
          />
        ) : null}
        <path
          d={path}
          fill="none"
          stroke={SERIES}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {[active ?? last].map((i) => (
          <circle
            key={i}
            cx={x(i)}
            cy={y(points[i]!.value)}
            r={4}
            fill={SERIES}
            stroke="var(--background)"
            strokeWidth={2}
          />
        ))}
        {points.map((p, i) => (
          <rect
            key={`hit-${p.label}`}
            x={x(i) - innerW / (2 * Math.max(1, points.length - 1))}
            y={PAD.top}
            width={innerW / Math.max(1, points.length - 1)}
            height={innerH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>
      {active !== null ? (
        <div
          className="border-border bg-background pointer-events-none absolute rounded-md border px-2 py-1 text-xs whitespace-nowrap shadow-sm"
          style={{ left: `${(x(active) / W) * 100}%`, top: 0, transform: "translateX(-50%)" }}
          role="status"
        >
          <div className="text-muted-foreground">{points[active]!.label}</div>
          <div className="font-medium tabular-nums">
            {points[active]!.value} {valueLabel.toLowerCase()}
          </div>
        </div>
      ) : null}
    </div>
  );
}
