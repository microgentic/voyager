export type RouteResult = Response | null;
export type JsonObject = Record<string, unknown>;

export interface PageParams {
  limit: number;
  offset: number;
}

export interface AppBootstrapResult {
  bootstrap: JsonObject;
  metrics: {
    roomsMs: number;
    messagesMs: number;
  };
}
