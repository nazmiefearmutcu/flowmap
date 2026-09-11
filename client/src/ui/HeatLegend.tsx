/**
 * Heatmap liquidity legend (§9) — a compact vertical colour scale pinned to the
 * heatmap's top-right, so the ramp self-documents (denser liquidity → hotter)
 * the way a professional order-flow terminal always pins a heat scale.
 *
 * The bar is painted from {@link rampCssGradient}, i.e. from the SAME stop list
 * `gl/lut.ts` rasterizes the GPU texture from — not a hand-copied CSS gradient
 * that silently drifts when the ramp is retuned. CSS interpolates sRGB linearly
 * exactly as `buildRamp` does, so the legend IS the ramp, not an approximation.
 *
 * F6 (visual campaign 2026-09-11): when the colormap is `'theme'` the bar paints
 * the ACTIVE theme's density stops (`THEMES[theme].chart.density` — the same
 * list the renderer uploads to atlas row 5), so the legend follows a light theme
 * the moment it switches; the legacy families keep the frozen lut rows.
 *
 * Depth channel (fix 2026-09-10 F1-5): the legend mirrors the channel the chart
 * is actually rendering (the settings store's `depthChannel`):
 *   - `sum` — the density ramp, "more"/"less" caps (unchanged default);
 *   - `imbalance` — the DIVERGENT row (`RAMP_IMBALANCE`) with the chart's
 *     vertical semantics: asks (ice blue) sit ABOVE the mid, bids (amber) BELOW,
 *     so the top cap reads "ask-heavy" and the bottom "bid-heavy";
 *   - `bid` / `ask` — the density ramp kept, labelled "bid depth"/"ask depth".
 *
 * Honesty (§7): when the depth tier is synthetic the bar switches to the amber
 * ramp + a `SYNTH` cap, mirroring the heatmap itself — the legend can never imply
 * the colours mean real resting liquidity when they don't, and no colormap or
 * channel setting can override that (see `rampForMode`). Capability is a
 * low-frequency store slice, so this never touches the GL render path.
 */

import { rampCssGradient, rampCssGradientReversed, rampForColormap, RAMP_IMBALANCE, RAMP_SYNTH, RAMP_THEME, RAMP_THEME_SYNTH, type Colormap } from '../gl/lut';
import type { DepthChannelMode } from './settings';
import { useFlowMapStore } from '../state/store';
import { THEMES, useTheme } from '../theme';
import { depthTier } from './DomLadder';

interface HeatLegendProps {
  /** The user's colormap family (ignored for synthetic depth). */
  colormap: Colormap;
  /** The depth channel the renderer is showing (settings store). */
  channel: DepthChannelMode;
}

/** Minimal stop shape the legend needs (structurally `ChartStop`). */
export interface LegendStop {
  readonly t: number;
  readonly rgb: readonly [number, number, number];
}

/**
 * CSS stop list from a theme ramp — same serialization as lut's private
 * gradient helper, so a `'theme'` legend bar is the theme atlas row, not an
 * approximation.
 */
function stopsGradient(stops: readonly LegendStop[]): string {
  return stops
    .map((s) => {
      const [r, g, b] = s.rgb.map((v) => Math.round(v));
      return `rgb(${r}, ${g}, ${b}) ${(s.t * 100).toFixed(1)}%`;
    })
    .join(', ');
}

/** Legend copy + ramp row per (channel, tier) — pure, unit-testable. */
export function legendForChannel(
  channel: DepthChannelMode,
  colormap: Colormap,
  synth: boolean,
  /** Active theme's density stops — required for the `'theme'` colormap. */
  themeStops?: readonly LegendStop[] | null,
  /** Active theme's synthetic-depth stops — pairs with `'theme'` + SYNTH. */
  themeSynthStops?: readonly LegendStop[] | null,
): {
  row: number;
  /** Stop list painted bottom → top of the bar (CSS `to top` order). */
  gradient: string;
  topCap: string;
  bottomCap: string;
  /** Extra channel note under the tier tag (null = none). */
  channelNote: string | null;
  /** Colouring phrase for the aria-label (already reads naturally). */
  rampName: string;
} {
  if (synth) {
    // R1-M2: with the `'theme'` colormap the renderer paints atlas row 6 (the
    // active theme's synth ramp), so the legend must paint the SAME stops —
    // not the frozen amber row 1. Legacy families keep the amber row.
    if (colormap === 'theme' && themeSynthStops && themeSynthStops.length > 0) {
      return {
        row: RAMP_THEME_SYNTH,
        gradient: stopsGradient(themeSynthStops),
        topCap: 'more',
        bottomCap: 'less',
        channelNote: null,
        rampName: 'synthetic theme colormap',
      };
    }
    return {
      row: RAMP_SYNTH,
      gradient: rampCssGradient(RAMP_SYNTH),
      topCap: 'more',
      bottomCap: 'less',
      channelNote: null,
      rampName: 'synthetic amber colormap',
    };
  }
  if (channel === 'imbalance') {
    // Divergent row, FLIPPED vertically so the bar matches the chart: the LUT
    // row's t=1 amber bid stop is painted FIRST in the `to top` gradient
    // (bottom of the bar) and its t=0 ice-blue ask stop lands on TOP — asks
    // above the mid, bids below, exactly like the chart.
    return {
      row: RAMP_IMBALANCE,
      gradient: rampCssGradientReversed(RAMP_IMBALANCE),
      topCap: 'ask-heavy',
      bottomCap: 'bid-heavy',
      channelNote: null,
      rampName: 'divergent imbalance (ask blue → bid amber)',
    };
  }
  if (colormap === 'theme' && themeStops && themeStops.length > 0) {
    return {
      row: RAMP_THEME,
      gradient: stopsGradient(themeStops),
      topCap: 'more',
      bottomCap: 'less',
      channelNote: channel === 'bid' ? 'bid depth' : channel === 'ask' ? 'ask depth' : null,
      rampName: 'theme colormap',
    };
  }
  return {
    row: rampForColormap(colormap),
    gradient: rampCssGradient(rampForColormap(colormap)),
    topCap: 'more',
    bottomCap: 'less',
    channelNote: channel === 'bid' ? 'bid depth' : channel === 'ask' ? 'ask depth' : null,
    rampName: `${colormap} colormap`,
  };
}

export function HeatLegend({ colormap, channel }: HeatLegendProps): JSX.Element {
  const { theme } = useTheme();
  const capability = useFlowMapStore((s) => s.capability);
  const tier = depthTier(capability, null);
  const synth = tier === 'SYNTH';
  // F6: `'theme'` follows the active theme's density ramp. Midnight's ramp is
  // byte-identical to FLOW at the source (registry constraint), so the default
  // stays pixel-for-pixel today's legend.
  const themeStops = colormap === 'theme' ? THEMES[theme].chart.density : null;
  const themeSynthStops = colormap === 'theme' ? THEMES[theme].chart.synth : null;
  const legend = legendForChannel(channel, colormap, synth, themeStops, themeSynthStops);
  const channelSuffix =
    channel === 'sum' || synth ? '' : `, ${channel} channel`;
  return (
    <div
      className={`heat-legend${synth ? ' heat-legend--synth' : ''}${
        !synth && channel === 'imbalance' ? ' heat-legend--divergent' : ''
      }`}
      data-testid="heat-legend"
      data-channel={channel}
      role="img"
      aria-label={`Liquidity scale, ${legend.rampName}${channelSuffix}${tier ? `, ${tier} depth` : ''}`}
    >
      <span className="heat-legend__cap">{legend.topCap}</span>
      <div
        className="heat-legend__bar"
        data-testid="heat-legend-bar"
        data-ramp={legend.row}
        style={{ background: `linear-gradient(to top, ${legend.gradient})` }}
        aria-hidden="true"
      />
      <span className="heat-legend__cap">{legend.bottomCap}</span>
      <span className="heat-legend__tier" data-testid="heat-legend-tier">
        {tier ?? 'liq'}
      </span>
      {legend.channelNote !== null && (
        <span className="heat-legend__channel" data-testid="heat-legend-channel">
          {legend.channelNote}
        </span>
      )}
    </div>
  );
}
