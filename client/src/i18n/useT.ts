/**
 * React binding for the i18n lookup (lane CE, C7).
 *
 * `useT()` subscribes the component to locale changes and returns the
 * {@link t} function. Because `t` reads the module-level locale at CALL
 * time, the useSyncExternalStore subscription is what forces the re-render;
 * the returned function itself is stable.
 */

import { useSyncExternalStore } from 'react';

import { getLocale, subscribeLocale, t } from './index';

export type TFn = typeof t;

export function useT(): TFn {
  useSyncExternalStore(subscribeLocale, getLocale);
  return t;
}
