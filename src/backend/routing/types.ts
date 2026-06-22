import type { AuthContext, Env } from "../../types";
import type { RouteResult } from "../internal-types";

export interface BackendRouteContext {
  request: Request;
  env: Env;
  url: URL;
  requestId: string;
  auth: AuthContext;
  authTimingMs: number;
}

export type BackendRouteHandler = (context: BackendRouteContext) => Promise<RouteResult>;
