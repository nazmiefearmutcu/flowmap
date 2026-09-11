/**
 * `C` hotkey for the depth display channel (campaign 3, lane CD, contract C2).
 *
 * Invisible mount: just the keyboard surface for cycling
 * sum → bid → ask → imbalance. The channel VALUE lives in the settings store
 * (`depthChannel`) and is applied by App via `renderer.setDepthChannel(mode)`
 * — this component never touches the renderer, so a build without the C2
 * setter simply keeps the default view while the setting still cycles.
 */

import { useEffect } from 'react';

import { classifyTarget, routeGlobalKey } from '../input/keys';

interface DepthChannelHotkeyProps {
  /** Called on `C` — App cycles the persisted `depthChannel` setting. */
  onCycle: () => void;
}

export function DepthChannelHotkey({ onCycle }: DepthChannelHotkeyProps): null {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const action = routeGlobalKey(e.key, classifyTarget(e.target));
      if (action?.type !== 'cycle-depth-channel') return;
      e.preventDefault();
      onCycle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCycle]);
  return null;
}
