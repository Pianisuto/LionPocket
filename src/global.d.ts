import type { LionPocketApi } from './shared/types';

declare global {
  interface Window {
    lionPocket: LionPocketApi;
  }
}

export {};

