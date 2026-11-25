import React from 'react';
import { KPISeriesPoint } from '../engine';

export const TelemetryCharts: React.FC<{
  series: readonly KPISeriesPoint[];
  compareSeries?: readonly KPISeriesPoint[];
}> = ({ series, compareSeries }) => {
  const recent = series.slice(-40);
  const recentCompare = compareSeries?.slice(-40);

  const renderSparkline = (
    values: number[],
    compareValues: number[] | undefined,
    stroke: string,
    label: string,
    unit: string
  ) => {
    const w = 236;
    const h = 44;
    const all = [...values, ...(compareValues ?? [])];
    const max = Math.max(1, ...all);
    const toPoints = (arr: number[]) =>
      arr
        .map((v, idx) => {
          const x = arr.length <= 1 ? 0 : (idx / (arr.length - 1)) * w;
          const y = h - 4 - (v / max) * (h - 10);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');

    const latest = values.length > 0 ? values[values.length - 1]! : 0;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
          <span style={{ color: 'var(--bone-muted)' }}>{label}</span>
          <span style={{ color: stroke, fontWeight: 600 }}>
            {latest.toFixed(1)}
            {unit}
          </span>
        </div>
        <svg width={w} height={h} style={{ background: 'rgba(10,11,15,0.55)', borderRadius: 6 }}>
          {compareValues && compareValues.length > 1 && (
            <polyline
              fill="none"
              stroke="#9FE8FF"
              strokeWidth="1.5"
              strokeDasharray="3 2"
              points={toPoints(compareValues)}
            />
          )}
          {values.length > 1 && (
            <polyline fill="none" stroke={stroke} strokeWidth="2" points={toPoints(values)} />
          )}
        </svg>
      </div>
    );
  };

  // Trade-off plot: Throughput vs Wait vs Congestion (last 24 ticks)
  const tradeoffPts = recent.slice(-24);
  const maxTp = Math.max(10, ...tradeoffPts.map((p) => p.throughputPer100Ticks));
  const maxDelay = Math.max(5, ...tradeoffPts.map((p) => p.avgPickupDelay));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {renderSparkline(
        recent.map((p) => p.throughputPer100Ticks),
        recentCompare?.map((p) => p.throughputPer100Ticks),
        '#C6FF3D',
        'Throughput (jobs / 100t)',
        ''
      )}
      {renderSparkline(
        recent.map((p) => p.avgPickupDelay),
        recentCompare?.map((p) => p.avgPickupDelay),
        '#9FE8FF',
        'Avg Pickup Delay (ticks)',
        't'
      )}
      {renderSparkline(
        recent.map((p) => p.congestionIndex * 100),
        recentCompare?.map((p) => p.congestionIndex * 100),
        '#FF5A4E',
        'Aisle Congestion (%)',
        '%'
      )}

      <div>
        <div style={{ fontSize: 10, color: 'var(--bone-muted)', marginBottom: 4 }}>
          Trade-Off: Throughput (X) vs Pickup Delay (Y) vs Congestion (Size)
        </div>
        <svg
          width={236}
          height={66}
          style={{ background: 'rgba(10,11,15,0.55)', borderRadius: 6 }}
        >
          <line x1={16} y1={54} x2={226} y2={54} stroke="rgba(242,239,230,0.16)" />
          <line x1={16} y1={8} x2={16} y2={54} stroke="rgba(242,239,230,0.16)" />
          {tradeoffPts.map((pt, idx) => {
            const cx = 20 + (pt.throughputPer100Ticks / maxTp) * 200;
            const cy = 50 - (pt.avgPickupDelay / maxDelay) * 38;
            const r = Math.max(2.5, Math.min(7, 2.5 + pt.congestionIndex * 10));
            return (
              <circle
                key={idx}
                cx={cx}
                cy={cy}
                r={r}
                fill={pt.congestionIndex > 0.35 ? '#FF5A4E' : '#C6FF3D'}
                fillOpacity={0.35 + (idx / Math.max(1, tradeoffPts.length)) * 0.65}
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
};
