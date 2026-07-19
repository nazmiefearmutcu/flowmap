/**
 * Heatmap liquidity legend (§9) — a compact vertical colour scale pinned to the
 * heatmap's top-right, so the thermal ramp self-documents (denser liquidity →
 * brighter) the way a professional order-flow terminal always pins a heat scale.
 *
 * Honesty (§7): when the depth tier is synthetic the bar switches to the amber
 * ramp + a `SYNTH` cap, mirroring the heatmap itself — the legend can never imply
 * the colours mean real resting liquidity when they don't. Capability is a
 * low-frequency store slice, so this never touches the GL render path.
 */

import { useFlowMapStore } from '../state/store';
import { depthTier } from './DomLadder';

export function HeatLegend(): JSX.Element {
  const capability = useFlowMapStore((s) => s.capability);
  const tier = depthTier(capability, null);
  const synth = tier === 'SYNTH';
  return (
    <div
      className={`heat-legend${synth ? ' heat-legend--synth' : ''}`}
      data-testid="heat-legend"
    >
      <span className="heat-legend__cap">more</span>
      <div className="heat-legend__bar" aria-hidden="true" />
      <span className="heat-legend__cap">less</span>
      <span className="heat-legend__tier" data-testid="heat-legend-tier">
        {tier ?? 'liq'}
      </span>
    </div>
  );
}
