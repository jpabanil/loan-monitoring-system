"use client";

import { formatPeso, formatPesoCompact, type Centavos } from "@lms/shared";
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useThemeMode } from "./ThemeProvider";

/** Chart palette (dataviz reference palette, slot 1 blue), stepped per mode. */
function useChartColors() {
  const { resolved } = useThemeMode();
  const dark = resolved === "dark";
  return {
    series: dark ? "#3987e5" : "#2a78d6",
    seriesSoft: dark ? "rgba(57,135,229,0.45)" : "rgba(42,120,214,0.45)",
    grid: dark ? "rgba(255,255,255,0.07)" : "rgba(15,23,42,0.07)",
    text: dark ? "#b4b9cc" : "#52514e",
    textStrong: dark ? "#eef0f8" : "#0f172a",
    cursor: dark ? "rgba(255,255,255,0.05)" : "rgba(15,23,42,0.04)",
  };
}

interface TipProps {
  active?: boolean;
  payload?: { value: number; payload: Record<string, unknown> }[];
  label?: string;
  noun: string;
  countKey?: string;
}

function GlassTip({ active, payload, label, noun, countKey }: TipProps) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!;
  const count = countKey ? (p.payload[countKey] as number) : undefined;
  return (
    <div className="chart-tip">
      <div className="faint" style={{ marginBottom: 2 }}>{label}</div>
      <div>
        {noun}: <b>{formatPeso(p.value as Centavos)}</b>
      </div>
      {count !== undefined ? <div className="faint">{count} {count === 1 ? "item" : "items"}</div> : null}
    </div>
  );
}

export interface MonthPoint {
  month: string;
  amount: Centavos;
  count: number;
  partial?: boolean;
}

/** Collections per month: one series, so the title names it and no legend is drawn. */
export function CollectionsChart({ data }: { data: MonthPoint[] }) {
  const c = useChartColors();
  return (
    <div style={{ width: "100%", height: 280 }} role="img" aria-label={`Collections by month: ${data.map((d) => `${d.month} ${formatPeso(d.amount)}`).join(", ")}`}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 22, right: 8, left: 0, bottom: 0 }} barCategoryGap="28%">
          <CartesianGrid vertical={false} stroke={c.grid} />
          <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fill: c.text, fontSize: 12 }} />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={64}
            tick={{ fill: c.text, fontSize: 12 }}
            tickFormatter={(v: number) => formatPesoCompact(v)}
          />
          <Tooltip cursor={{ fill: c.cursor }} content={<GlassTip noun="Collected" countKey="count" />} />
          <Bar dataKey="amount" radius={[4, 4, 0, 0]} maxBarSize={44} fill={c.series}>
            <LabelList
              dataKey="amount"
              position="top"
              content={(props) => {
                const { x, y, width, value, index } = props as { x: number; y: number; width: number; value: number; index: number };
                if (index !== data.length - 1 && index !== data.length - 2) return null;
                return (
                  <text x={x + width / 2} y={y - 7} textAnchor="middle" fontSize={11.5} fill={c.textStrong} fontWeight={600}>
                    {formatPesoCompact(value)}
                  </text>
                );
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface BucketPoint {
  bucket: string;
  amount: Centavos;
  count: number;
}

/** Outstanding balance by aging bucket, horizontal so labels read naturally. */
export function AgingChart({ data }: { data: BucketPoint[] }) {
  const c = useChartColors();
  return (
    <div style={{ width: "100%", height: 260 }} role="img" aria-label={`Outstanding by days past due: ${data.map((d) => `${d.bucket} ${formatPeso(d.amount)}`).join(", ")}`}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 64, left: 4, bottom: 4 }} barCategoryGap="22%">
          <CartesianGrid horizontal={false} stroke={c.grid} />
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="bucket" tickLine={false} axisLine={false} width={96} tick={{ fill: c.text, fontSize: 12 }} />
          <Tooltip cursor={{ fill: c.cursor }} content={<GlassTip noun="Outstanding" countKey="count" />} />
          <Bar dataKey="amount" radius={[0, 4, 4, 0]} maxBarSize={26} fill={c.series}>
            <LabelList
              dataKey="amount"
              position="right"
              content={(props) => {
                const { x, y, width, height, value } = props as { x: number; y: number; width: number; height: number; value: number };
                return (
                  <text x={x + width + 6} y={y + height / 2} dominantBaseline="central" fontSize={11.5} fill={c.textStrong} fontWeight={600}>
                    {formatPesoCompact(value)}
                  </text>
                );
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
