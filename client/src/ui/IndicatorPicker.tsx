/**
 * IndicatorPicker (campaign 3, lane CG) — the popover over the chart that
 * manages the active indicator set.
 *
 * - Lists the REGISTRY (`indicators/registry.ts`): add/remove in one click,
 *   bounded by the store (8 active; the store evicts oldest past the bound).
 * - Active entries get PARAM editors (schema-driven min/max/step; every write
 *   is clamped in the store, so the kernels never see junk) and COLOR swatches
 *   per output (`<input type="color">`; the reset chip returns the theme var).
 * - The CANDLE SOURCE timeframe (1m/5m/15m) is selectable here and persists in
 *   localStorage via candles/store.
 * - `I` toggles it (self-listened with the app's typing/dialog guards); INT can
 *   also bind {@link toggleIndicatorPicker} programmatically. Esc closes.
 *
 * Pure DOM + the store; no canvas, no timer loops. Closed = renders null.
 */

import { useEffect } from 'react';

import { CANDLE_TIMEFRAMES, getSnapshot, setTimeframe } from '../candles/store';
import { INDICATOR_DEFS, defById } from '../indicators/registry';
import { useIndicatorStore, MAX_ACTIVE_INDICATORS } from '../indicators/store';
import { classifyTarget } from '../input/keys';
import '../indicators/indicators.css';

export { toggleIndicatorPicker } from '../indicators/store';

export function IndicatorPicker(): JSX.Element | null {
  const open = useIndicatorStore((s) => s.pickerOpen);
  const active = useIndicatorStore((s) => s.active);

  // `I` toggles; Esc closes. Same focus-safety rules as the app router: never
  // while typing (a typed `i` is a search character) and never while a modal
  // owns the keyboard (the drawer/shortcuts close themselves).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = classifyTarget(e.target);
      if (target.editable) return;
      if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        useIndicatorStore.getState().togglePicker();
        return;
      }
      if (e.key !== 'Escape' || !useIndicatorStore.getState().pickerOpen) return;
      const t = e.target as HTMLElement | null;
      if (typeof t?.closest === 'function' && t.closest('[role="dialog"]') !== null) return;
      useIndicatorStore.getState().setPickerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!open) return null;

  const tfNs = getSnapshot().timeframeNs;
  const atCap = active.length >= MAX_ACTIVE_INDICATORS;

  return (
    <div className="indi-picker" data-testid="indi-picker" role="dialog" aria-label="Indicators">
      <div className="indi-picker__head">
        <span className="indi-picker__title">Indicators</span>
        <button
          type="button"
          className="indi-picker__close"
          data-testid="indi-close"
          aria-label="Close indicators"
          onClick={() => useIndicatorStore.getState().setPickerOpen(false)}
        >
          ×
        </button>
      </div>

      <label className="indi-picker__row">
        <span>Candles</span>
        <select
          className="indi-picker__select"
          data-testid="indi-tf"
          value={String(tfNs)}
          onChange={(e) => setTimeframe(Number(e.target.value))}
        >
          {CANDLE_TIMEFRAMES.map((tf) => (
            <option key={tf.ns} value={String(tf.ns)}>
              {tf.label}
            </option>
          ))}
        </select>
      </label>

      <div className="indi-picker__scroll">
        <div>
          <div className="indi-picker__section">
            Active ({active.length}/{MAX_ACTIVE_INDICATORS})
          </div>
          {active.length === 0 ? (
            <div className="indi-picker__empty" data-testid="indi-active-empty">
              None — add a study below.
            </div>
          ) : (
            <ul className="indi-picker__list">
              {active.map((a) => {
                const def = defById(a.defId);
                if (def === null) return null;
                return (
                  <li key={a.uid} data-testid={`indi-active-${a.defId}`}>
                    <div className="indi-row">
                      <span className="indi-row__name">
                        {def.name}
                        {def.params.length > 0 &&
                          ` (${def.params.map((p) => a.params[p.key]).join(' / ')})`}
                      </span>
                      <button
                        type="button"
                        className="indi-row__remove"
                        data-testid={`indi-remove-${a.uid}`}
                        aria-label={`Remove ${def.name}`}
                        onClick={() => useIndicatorStore.getState().remove(a.uid)}
                      >
                        ✕
                      </button>
                    </div>
                    <div className="indi-params">
                      {def.params.map((p) => (
                        <label key={p.key} className="indi-param">
                          <span>{p.label}</span>
                          <input
                            type="number"
                            data-testid={`indi-param-${a.uid}-${p.key}`}
                            value={a.params[p.key]}
                            min={p.min}
                            max={p.max}
                            step={p.step}
                            onChange={(e) =>
                              useIndicatorStore.getState().setParam(a.uid, p.key, Number(e.target.value))
                            }
                          />
                        </label>
                      ))}
                      {def.outputs.map((o) => (
                        <span key={o.key} className="indi-color">
                          <input
                            type="color"
                            data-testid={`indi-color-${a.uid}-${o.key}`}
                            aria-label={`${def.name} ${o.label} color`}
                            value={a.colors[o.key] ?? '#000000'}
                            onChange={(e) =>
                              useIndicatorStore.getState().setColor(a.uid, o.key, e.target.value)
                            }
                          />
                          <button
                            type="button"
                            className="indi-color__reset"
                            data-testid={`indi-color-reset-${a.uid}-${o.key}`}
                            title="Theme default"
                            onClick={() => useIndicatorStore.getState().setColor(a.uid, o.key, null)}
                          >
                            auto
                          </button>
                        </span>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          <div className="indi-picker__section">Add</div>
          <ul className="indi-picker__list">
            {INDICATOR_DEFS.map((def) => (
              <li key={def.id} className="indi-row">
                <span className="indi-row__name">
                  {def.name}
                  {def.params.length > 0 &&
                    ` (${def.params.map((p) => String(p.default)).join(' / ')})`}
                </span>
                <button
                  type="button"
                  className="indi-row__add"
                  data-testid={`indi-add-${def.id}`}
                  disabled={atCap}
                  title={atCap ? `Limit of ${MAX_ACTIVE_INDICATORS} active indicators reached` : undefined}
                  onClick={() => useIndicatorStore.getState().add(def.id)}
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
