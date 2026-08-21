"use client";

import * as React from "react";
import { buildBandwidthSeries } from "@/lib/traffic-snapshots";
import { cn } from "@/lib/utils";
import type { BandwidthDataPoint } from "@/types";

interface BandwidthMiniChartProps {
  data: BandwidthDataPoint[];
  currentBandwidth?: number;
  onClick?: () => void;
  className?: string;
}

export function BandwidthMiniChart({
  data,
  currentBandwidth: externalBandwidth,
  onClick,
  className,
}: BandwidthMiniChartProps) {
  const bandwidthSeries = React.useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    return buildBandwidthSeries(data, now);
  }, [data]);
  const { linePoints, areaPoints } = React.useMemo(() => {
    const maxBandwidth = Math.max(1, ...bandwidthSeries);
    const points = bandwidthSeries.map((bandwidth, index) => {
      const x = (index / (bandwidthSeries.length - 1)) * 100;
      const y = 11 - (bandwidth / maxBandwidth) * 10;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    return {
      linePoints: points.join(" "),
      areaPoints: `0,11 ${points.join(" ")} 100,11`,
    };
  }, [bandwidthSeries]);

  // Use external bandwidth if provided, otherwise calculate from last data point
  const currentBandwidth =
    externalBandwidth ?? bandwidthSeries[bandwidthSeries.length - 1] ?? 0;

  // Format bytes to human readable
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B/s";
    if (bytes < 1024) return `${bytes} B/s`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`;
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded border-none bg-transparent px-2 transition-colors hover:bg-muted",
        className,
      )}
    >
      <div className="pointer-events-none h-3 min-w-0 flex-1">
        <svg
          viewBox="0 0 100 12"
          preserveAspectRatio="none"
          className="block size-full"
          aria-hidden="true"
        >
          <polygon
            points={areaPoints}
            fill="var(--chart-1)"
            fillOpacity="0.16"
          />
          <polyline
            points={linePoints}
            fill="none"
            stroke="var(--chart-1)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      <span className="min-w-[60px] shrink-0 text-right text-xs whitespace-nowrap text-muted-foreground">
        {formatBytes(currentBandwidth)}
      </span>
    </button>
  );
}
