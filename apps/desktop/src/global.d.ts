import type { LionPocketApi } from './api';

declare global {
  interface Window {
    lionPocket: LionPocketApi;
  }
}

export {};
