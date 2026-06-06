interface Env {
  CONTROL_DB: D1Database;
  ATTACHMENTS_BUCKET: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "voyager-api-dev",
        status: "healthy",
        d1: Boolean(env.CONTROL_DB) ? "bound" : "missing",
        r2: Boolean(env.ATTACHMENTS_BUCKET) ? "bound" : "missing",
        timestamp: new Date().toISOString()
      });
    }

    return Response.json(
      {
        ok: false,
        error: "not_found"
      },
      { status: 404 }
    );
  }
};
