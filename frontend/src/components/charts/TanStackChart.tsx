import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { getLocale } from '@/i18n';
import { useEffect, useMemo, useState } from 'react';
import { areaY, barX, barY, defineChart, lineY, stack } from '@tanstack/charts';
import { controlledSignal } from '@tanstack/charts/interaction/signal';
import { zoomX, type ZoomXChange } from '@tanstack/charts/interaction/zoom';
import { interactiveColorLegend, type InteractiveColorLegendChange } from '@tanstack/charts/legend';
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
  category: string | number;
  values: Record<string, number | null | undefined>;
  detail?: string;
  color?: string;
}

interface LongDatum {
  category: string | number;
  value: number;
  series: string;
  label: string;
  color: string;
  detail?: string;
}

export interface ChartViewport {
  start: number;
  end: number;
}

function useVisibleSeries(series: ChartSeries[]) {
  useLingui();

  const seriesKeys = useMemo(() => series.map((descriptor) => descriptor.key), [series]);
  const [visibleSeries, setVisibleSeries] = useState<readonly string[]>(seriesKeys);

  useEffect(() => {
    setVisibleSeries((current) => {
      const retained = current.filter((key) => seriesKeys.includes(key));
      const added = seriesKeys.filter((key) => !current.includes(key));
      const next = [...retained, ...added];
      return next.length === current.length && next.every((key, index) => key === current[index])
        ? current
        : next;
    });
  }, [seriesKeys]);

  return { visibleSeries, setVisibleSeries };
}

function chartDescription(data: ChartDatum[], series: ChartSeries[], zoomable = false): string {
  const labels = series.map((descriptor) => descriptor.label).join(', ');
  return `${data.length} data point${data.length === 1 ? '' : 's'}${labels ? ` for ${labels}` : ''}. Use arrow keys to inspect values${zoomable ? '; use plus, minus, arrow keys, or Home to change the time window' : ''}.`;
}

export function TanStackTimeSeriesChart({
  data,
  series,
  height,
  ariaLabel,
  variant = 'line',
  valueFormatter,
  xValueFormatter,
  viewport,
  fullExtent,
  onViewportChange,
}: {
  data: ChartDatum[];
  series: ChartSeries[];
  height: number;
  ariaLabel: string;
  variant?: 'line' | 'area';
  valueFormatter?: (value: number) => string;
  xValueFormatter?: (value: number) => string;
  viewport?: ChartViewport;
  fullExtent?: readonly [number, number];
  onViewportChange?: (viewport: ChartViewport, reason: ZoomXChange<number>) => void;
}) {
  useLingui();

  const { visibleSeries, setVisibleSeries } = useVisibleSeries(series);
  const zoomable = Boolean(
    viewport && fullExtent && fullExtent[0] !== fullExtent[1] && onViewportChange
  );
  const definition = useMemo(() => {
    const marks = series.map((descriptor) => {
      const points: LongDatum[] = data.flatMap((datum, index) => {
        const value = datum.values[descriptor.key];
        return typeof value === 'number' && Number.isFinite(value)
          ? [
              {
                category:
                  typeof datum.category === 'string'
                    ? `${datum.category}${'\u200b'.repeat(index)}`
                    : datum.category,
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
        return areaY(points, {
          id: `${descriptor.key}-area`,
          x: 'category',
          y: 'value',
          yScale: descriptor.axis === 'right' ? 'yRight' : 'yLeft',
          color: 'series',
          fill: descriptor.color,
          fillOpacity: 0.15,
          stroke: descriptor.color,
          strokeWidth: 1.5,
        });
      }
      return lineY(points, {
        id: descriptor.label,
        x: 'category',
        y: 'value',
        yScale: descriptor.axis === 'right' ? 'yRight' : 'yLeft',
        color: 'series',
        stroke: descriptor.color,
        strokeWidth: 1.5,
        points: points.length <= 40,
      });
    });

    const valueAxis = {
      channel: 'y' as const,
      scale: scaleLinear,
      nice: true,
      grid: true,
      axis: valueFormatter
        ? { ticks: { format: (value: unknown) => valueFormatter(Number(value)) } }
        : {},
    };
    const numericX = data.every((datum) => typeof datum.category === 'number');
    const resolvedViewport =
      viewport && fullExtent && fullExtent[0] !== fullExtent[1] ? viewport : null;
    const controls =
      numericX && resolvedViewport && fullExtent && onViewportChange
        ? [
            zoomX({
              window: controlledSignal<ChartViewport, ZoomXChange<number>>(
                resolvedViewport,
                (next, context) => onViewportChange(next, context.reason)
              ),
              extent: fullExtent,
              scaleExtent: [1, Math.max(1, data.length)],
              wheelActivation: 'modifier',
              ariaLabel: `${ariaLabel} time window`,
              format: (value) => xValueFormatter?.(value) ?? String(value),
            }),
          ]
        : undefined;

    return defineChart({
      marks,
      scales: {
        x:
          numericX && resolvedViewport
            ? {
                scale: scaleLinear().domain([resolvedViewport.start, resolvedViewport.end]),
                axis: xValueFormatter
                  ? { ticks: { format: (value: unknown) => xValueFormatter(Number(value)) } }
                  : {},
              }
            : { scale: () => scalePoint<string | number>().padding(0.15) },
        y: null,
        yLeft: { ...valueAxis, side: 'left' },
        yRight: series.some((descriptor) => descriptor.axis === 'right')
          ? { ...valueAxis, side: 'right', grid: false }
          : null,
      },
      color: {
        domain: series.map((descriptor) => descriptor.key),
        range: series.map((descriptor) => descriptor.color),
        legend:
          series.length > 1
            ? interactiveColorLegend({
                visible: controlledSignal<readonly string[], InteractiveColorLegendChange<string>>(
                  visibleSeries,
                  (next) => setVisibleSeries(next)
                ),
                placement: 'bottom',
                ariaLabel: `${ariaLabel} series visibility`,
                format: (key) =>
                  series.find((descriptor) => descriptor.key === key)?.label ?? String(key),
              })
            : undefined,
      },
      focus: 'group-x',
      controls,
      svgAnimation: true,
      tooltip: {
        use: tooltip,
        format: (point) => {
          const datum = point.datum as LongDatum;
          return `${datum.label}: ${datum.detail ?? valueFormatter?.(datum.value) ?? datum.value.toLocaleString(getLocale())}`;
        },
        formatGroup: (points) => {
          const first = points[0]?.datum as LongDatum | undefined;
          const heading = first
            ? typeof first.category === 'number'
              ? (xValueFormatter?.(first.category) ?? String(first.category))
              : first.category.split('\u200b').join('')
            : '';
          return [
            heading,
            ...points.map((point) => {
              const datum = point.datum as LongDatum;
              return `${datum.label}: ${datum.detail ?? valueFormatter?.(datum.value) ?? datum.value.toLocaleString(getLocale())}`;
            }),
          ].join('\n');
        },
      },
    });
  }, [
    ariaLabel,
    data,
    fullExtent,
    onViewportChange,
    series,
    setVisibleSeries,
    valueFormatter,
    variant,
    viewport,
    visibleSeries,
    xValueFormatter,
  ]);

  if (data.length === 0 || series.length === 0) {
    return (
      <div role="img" aria-label={ariaLabel} className="text-sm text-muted-foreground">
        <Trans>No chart data available.</Trans>
      </div>
    );
  }

  return (
    <Chart
      definition={definition}
      height={height}
      ariaLabel={ariaLabel}
      ariaDescription={chartDescription(data, series, zoomable)}
    />
  );
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
  useLingui();

  const { visibleSeries, setVisibleSeries } = useVisibleSeries(series);
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
          color: 'series',
          fill: (datum) => datum.color,
          layout,
          radius: { end: 4, stack: stacked ? 'outer' : 'each' },
          maxThickness: 16,
        })
      : barY(points, {
          x: 'category',
          y: 'value',
          z: 'series',
          color: 'series',
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
      color: {
        domain: series.map((descriptor) => descriptor.key),
        range: series.map((descriptor) => descriptor.color),
        legend:
          series.length > 1
            ? interactiveColorLegend({
                visible: controlledSignal<readonly string[], InteractiveColorLegendChange<string>>(
                  visibleSeries,
                  (next) => setVisibleSeries(next)
                ),
                placement: 'bottom',
                ariaLabel: `${ariaLabel} series visibility`,
                format: (key) =>
                  series.find((descriptor) => descriptor.key === key)?.label ?? String(key),
              })
            : undefined,
      },
      focus: horizontal ? 'group-y' : 'group-x',
      svgAnimation: true,
      tooltip: {
        use: tooltip,
        format: (point) => {
          const datum = point.datum as LongDatum;
          return `${datum.label}: ${datum.detail ?? datum.value.toLocaleString(getLocale())}`;
        },
        formatGroup: (group) =>
          group
            .map((point) => {
              const datum = point.datum as LongDatum;
              return `${datum.label}: ${datum.detail ?? datum.value.toLocaleString(getLocale())}`;
            })
            .join('\n'),
      },
    });
  }, [ariaLabel, data, horizontal, series, setVisibleSeries, stacked, visibleSeries]);

  if (data.length === 0 || series.length === 0) {
    return (
      <div role="img" aria-label={ariaLabel} className="text-sm text-muted-foreground">
        <Trans>No chart data available.</Trans>
      </div>
    );
  }

  return (
    <Chart
      definition={definition}
      height={height}
      ariaLabel={ariaLabel}
      ariaDescription={chartDescription(data, series)}
    />
  );
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
  useLingui();

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
      svgAnimation: true,
      tooltip: {
        use: tooltip,
        format: (point) => {
          const datum = point.datum as { name: string; value: number };
          return `${datum.name}: ${datum.value.toLocaleString(getLocale())}`;
        },
      },
    });
  }, [data]);

  if (data.length === 0) {
    return (
      <div role="img" aria-label={ariaLabel} className="text-sm text-muted-foreground">
        <Trans>No chart data available.</Trans>
      </div>
    );
  }

  return (
    <Chart
      definition={definition}
      height={height}
      ariaLabel={ariaLabel}
      ariaDescription={`${data.length} slice${data.length === 1 ? '' : 's'}: ${data.map((datum) => datum.name).join(', ')}.`}
    />
  );
}
