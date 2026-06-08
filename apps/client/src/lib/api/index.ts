import { VoyagerClient } from './client';

/** App-wide singleton. The auth store wires the token + 401 handler. */
export const api = new VoyagerClient();

export { VoyagerClient } from './client';
export { ApiError, isApiError } from './errors';
export type * from './types';
