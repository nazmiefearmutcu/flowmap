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
 * Honesty (§7): when the depth tier is synthetic the bar switches to the amber
 * ramp + a `SYNTH` cap, mirroring the heatmap itself — the legend can never imply
 * the colours mean real resting liquidity when they don't, and no colormap
 * setting can override that (see `rampForMode`). Capability is a low-frequency
 * store slice, so this never touches the GL render path.
 */

import { rampCssGradient, rampForColormap, RAMP_SYNTH, type Colormap } from '../gl/lut';
import { useFlowMapStore } from '../state/store';
import { depthTier } from './DomLadder';

interface HeatLegendProps {
  /** The user's colormap family (ignored for synthetic depth). */
  colormap: Colormap;
}

export function HeatLegend({ colormap }: HeatLegendProps): JSX.Element {
  const capability = useFlowMapStore((s) => s.capability);
  const tier = depthTier(capability, null);
  const synth = tier === 'SYNTH';
  const row = synth ? RAMP_SYNTH : rampForColormap(colormap);
  const rampName = synth ? 'synthetic amber' : colormap;
  return (
    <div
      className={`heat-legend${synth ? ' heat-legend--synth' : ''}`}
      data-testid="heat-legend"
      role="img"
      aria-label={`Liquidity scale, ${rampName} colormap${tier ? `, ${tier} depth` : ''}`}
    >
      <span className="heat-legend__cap">more</span>
      <div
        className="heat-legend__bar"
        data-testid="heat-legend-bar"
        data-ramp={row}
        style={{ background: `linear-gradient(to top, ${rampCssGradient(row)})` }}
        aria-hidden="true"
      />
      <span className="heat-legend__cap">less</span>
      <span className="heat-legend__tier" data-testid="heat-legend-tier">
        {tier ?? 'liq'}
      </span>
    </div>
  );
}
