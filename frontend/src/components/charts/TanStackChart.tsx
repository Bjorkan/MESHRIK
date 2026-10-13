import { useMemo } from 'react';
import { areaY, barX, barY, defineChart, lineY, stack, type ChartMark } from '@tanstack/charts';
import { Chart } from '@tanstack/charts/react';
import { pie, polar, radialArc } from '@tanstack/charts/polar';
import { scaleBand } from '@tanstack/charts/scales/band';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { scalePoint } from '@tanstack/charts/scales/point';
import { tooltip } from '@tanstack/charts/tooltip';

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  axis?: 'left' | 'right';
  line?: boolean;
}

export interface ChartDatum {
  category: string;
  values: Record<string, number | null | undefined>;
  detail?: string;
  color?: string;
}

interface LongDatum {
  category: string;
  value: number;
  series: string;
  label: string;
  color: string;
  detail?: string;
}

export function TanStackTimeSeriesChart({
  data,
  series,
  height,
  ariaLabel,
  variant = 'line',
  valueFormatter,
}: {
  data: ChartDatum[];
  series: ChartSeries[];
  height: number;
  ariaLabel: string;
  variant?: 'line' | 'area';
  valueFormatter?: (value: number) => string;
}) {
  const definition = useMemo(() => {
    const marks: ChartMark[] = [];
    for (const descriptor of series) {
      const points: LongDatum[] = data.flatMap((datum, index) => {
        const value = datum.values[descriptor.key];
        return typeof value === 'number' && Number.isFinite(value)
          ? [
              {
                category: `${datum.category}${'\u200b'.repeat(index)}`,
                value,
                series: descriptor.key,
                label: descriptor.label,
                color: datum.color ?? descriptor.color,
                detail: datum.detail,
              },
            ]
          : [];
      });
      if (variant === 'area' && !descriptor.line) {
        marks.push(
          areaY(points, {
            id: `${descriptor.key}-area`,
            x: 'category',
            y: 'value',
            fill: descriptor.color,
            fillOpacity: 0.15,
            stroke: descriptor.color,
            strokeWidth: 1.5,
          })
        );
      } else {
        marks.push(
          lineY(points, {
            id: descriptor.label,
            x: 'category',
            y: 'value',
            stroke: descriptor.color,
            strokeWidth: 1.5,
            points: points.length <= 40,
          })
        );
      }
    }

    return defineChart({
      marks,
      scales: {
        x: {
          scale: () => scalePoint<string>().padding(0.15),
        },
        y: {
          scale: scaleLinear,
          nice: true,
          grid: true,
          axis: valueFormatter
            ? { ticks: { format: (value) => valueFormatter(Number(value)) } }
            : {},
        },
      },
      tooltip,
    });
  }, [data, series, valueFormatter, variant]);

  return <Chart definition={definition} height={height} ariaLabel={ariaLabel} />;
}

export function TanStackBarChart({
  data,
  series,
  height,
  ariaLabel,
  horizontal = false,
  stacked = false,
}: {
  data: ChartDatum[];
  series: ChartSeries[];
  height: number;
  ariaLabel: string;
  horizontal?: boolean;
  stacked?: boolean;
}) {
  const definition = useMemo(() => {
    const points: LongDatum[] = data.flatMap((datum, index) =>
      series.flatMap((descriptor) => {
        const value = datum.values[descriptor.key];
        return typeof value === 'number' && Number.isFinite(value)
          ? [
              {
                category: `${datum.category}${'\u200b'.repeat(index)}`,
                value,
                series: descriptor.key,
                label: descriptor.label,
                color: datum.color ?? descriptor.color,
                detail: datum.detail,
              },
            ]
          : [];
      })
    );
    const layout = stacked ? stack() : undefined;
    const mark = horizontal
      ? barX(points, {
          x: 'value',
          y: 'category',
          z: 'series',
          fill: (datum) => datum.color,
          layout,
          radius: { end: 4, stack: stacked ? 'outer' : 'each' },
          maxThickness: 16,
        })
      : barY(points, {
          x: 'category',
          y: 'value',
          z: 'series',
          fill: (datum) => datum.color,
          layout,
          radius: { end: 4, stack: stacked ? 'outer' : 'each' },
          maxThickness: 40,
        });

    return defineChart({
      marks: [mark],
      scales: horizontal
        ? {
            x: { scale: scaleLinear, nice: true, grid: true },
            y: { scale: () => scaleBand<string>().padding(0.2) },
          }
        : {
            x: { scale: () => scaleBand<string>().padding(0.18) },
            y: { scale: scaleLinear, nice: true, grid: true },
          },
      tooltip,
    });
  }, [data, horizontal, series, stacked]);

  return <Chart definition={definition} height={height} ariaLabel={ariaLabel} />;
}

export function TanStackDonutChart({
  data,
  height,
  ariaLabel,
}: {
  data: Array<{ name: string; value: number; color: string }>;
  height: number;
  ariaLabel: string;
}) {
  const definition = useMemo(() => {
    const slices = pie(data, { value: 'value' });
    return defineChart({
      marks: [
        polar({
          inset: 3,
          radiusRatio: 0.95,
          marks: [
            radialArc(slices, {
              innerRadius: ({ radius }) => radius * 0.55,
              cornerRadius: 2,
              color: 'name',
              key: 'name',
              stroke: 'hsl(var(--background))',
              strokeWidth: 1.5,
            }),
          ],
          scales: { angle: null, radius: null },
        }),
      ],
      scales: { x: null, y: null },
      color: {
        domain: data.map((datum) => datum.name),
        range: data.map((datum) => datum.color),
      },
      tooltip,
    });
  }, [data]);

  return <Chart definition={definition} height={height} ariaLabel={ariaLabel} />;
}
