import { useState } from "react";
import { createRoot } from "react-dom/client";

import {
  TanStackBarChart,
  TanStackDonutChart,
  TanStackTimeSeriesChart,
  type ChartViewport,
} from "../../../frontend/src/components/charts/TanStackChart";

import "./styles.css";

const timeline = [
  { category: "10:00", values: { direct: 3, flood: 7 } },
  { category: "10:15", values: { direct: 5, flood: 4 } },
  { category: "10:30", values: { direct: 2, flood: 9 } },
  { category: "10:45", values: { direct: 6, flood: 5 } },
];

const timeSeries = [
  { category: "Mon", values: { incoming: 4, outgoing: 2 } },
  { category: "Tue", values: { incoming: 7, outgoing: 5 } },
  { category: "Wed", values: { incoming: 5, outgoing: 8 } },
  { category: "Thu", values: { incoming: 9, outgoing: 6 } },
];

const telemetry = [
  { category: 100, values: { received: 100, delta: 0 } },
  { category: 200, values: { received: 118, delta: 18 } },
  { category: 300, values: { received: 131, delta: 13 } },
  { category: 400, values: { received: 155, delta: 24 } },
];

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section data-consumer={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Gallery() {
  const [viewport, setViewport] = useState<ChartViewport>({
    start: 100,
    end: 400,
  });
  return (
    <main aria-label="Chart consumer visual regression gallery">
      <Card title="RawPacketFeedView">
        <TanStackBarChart
          data={timeline}
          series={[
            { key: "direct", label: "Direct", color: "#0ea5e9" },
            { key: "flood", label: "Flood", color: "#10b981" },
          ]}
          height={210}
          ariaLabel="Traffic timeline"
          stacked
        />
      </Card>
      <Card title="ContactInfoPane">
        <TanStackTimeSeriesChart
          data={timeSeries}
          series={[
            { key: "incoming", label: "Incoming", color: "#0ea5e9" },
            { key: "outgoing", label: "Outgoing", color: "#f43f5e" },
          ]}
          height={210}
          ariaLabel="Contact message activity"
        />
      </Card>
      <Card title="ChannelInfoPane">
        <TanStackDonutChart
          data={[
            { name: "1-byte", value: 18, color: "#22c55e" },
            { name: "2-byte", value: 9, color: "#0ea5e9" },
            { name: "3-byte", value: 4, color: "#8b5cf6" },
          ]}
          height={210}
          ariaLabel="Path hash width distribution"
        />
      </Card>
      <Card title="RepeaterTelemetryHistoryPane">
        <TanStackTimeSeriesChart
          data={telemetry}
          series={[
            {
              key: "received",
              label: "Received",
              color: "#0ea5e9",
              axis: "left",
            },
            {
              key: "delta",
              label: "Received Δ",
              color: "#14b8a6",
              axis: "right",
              line: true,
            },
          ]}
          height={240}
          ariaLabel="Packets telemetry history"
          variant="area"
          valueFormatter={(value) => `${value} packets`}
          xValueFormatter={(value) => `T+${value}`}
          viewport={viewport}
          fullExtent={[100, 400]}
          onViewportChange={setViewport}
        />
      </Card>
      <Card title="SettingsStatisticsSection">
        <div className="chart-pair">
          <TanStackTimeSeriesChart
            data={timeSeries.map((point) => ({
              category: point.category,
              values: { count: point.values.incoming + point.values.outgoing },
            }))}
            series={[{ key: "count", label: "Packets", color: "#0ea5e9" }]}
            height={180}
            ariaLabel="Packets per hour over 72 hours"
            variant="area"
          />
          <TanStackBarChart
            data={[
              { category: "Channels", values: { count: 12 } },
              { category: "Contacts", values: { count: 37 } },
              { category: "Packets", values: { count: 126 } },
            ]}
            series={[{ key: "count", label: "Count", color: "#8b5cf6" }]}
            height={180}
            ariaLabel="Network totals"
          />
        </div>
      </Card>
    </main>
  );
}

const theme =
  new URLSearchParams(window.location.search).get("theme") ?? "dark";
document.documentElement.dataset.theme = theme;
createRoot(document.getElementById("root")!).render(<Gallery />);
