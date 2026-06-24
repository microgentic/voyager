import type { AuthContext, Env } from "./types";

export const CALL_REALTIME_PROTOCOL = "voyager.call-realtime.v1";

type CallRealtimeEventType =
  | "call.invite"
  | "call.ringing"
  | "call.joined"
  | "call.left"
  | "call.ended"
  | "call.updated";

interface CallRealtimeEvent {
  type: CallRealtimeEventType;
  eventId: string;
  createdAt: string;
  roomId: string;
  callId?: string;
  callType?: "audio" | "video";
  status?: string;
  createdByPrincipalId?: string;
  principalId?: string;
  deviceId?: string;
  reason?: string;
  endedReason?: string;
}

type CallRealtimeEventInput = Omit<CallRealtimeEvent, "eventId" | "createdAt" | "roomId">;

interface SocketAttachment {
  accountId: string;
  principalId: string;
  deviceId: string;
  connectedAt: string;
}

export async function handleCallRealtimeConnect(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  const id = env.REALTIME_MAILBOX.idFromName(auth.account.account_id);
  const stub = env.REALTIME_MAILBOX.get(id);
  const headers = new Headers(request.headers);
  headers.set("x-voyager-account-id", auth.account.account_id);
  headers.set("x-voyager-principal-id", auth.principal.principal_id);
  headers.set("x-voyager-device-id", auth.device.device_id);

  return stub.fetch("https://voyager-call-realtime.local/connect", { headers });
}

export async function notifyRoomCallRealtime(
  env: Env,
  roomId: string,
  event: CallRealtimeEventInput
): Promise<void> {
  const result = await env.CONTROL_DB.prepare(
    "SELECT DISTINCT account_id FROM room_memberships WHERE room_id = ? AND status = 'active' AND account_id IS NOT NULL"
  )
    .bind(roomId)
    .all<{ account_id: string }>();
  const accountIds = (result.results ?? []).map((row) => row.account_id);
  await notifyAccountsCallRealtime(env, accountIds, {
    type: event.type,
    eventId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    roomId,
    callId: event.callId,
    callType: event.callType,
    status: event.status,
    createdByPrincipalId: event.createdByPrincipalId,
    principalId: event.principalId,
    deviceId: event.deviceId,
    reason: event.reason,
    endedReason: event.endedReason
  });
}

async function notifyAccountsCallRealtime(env: Env, accountIds: string[], event: CallRealtimeEvent): Promise<void> {
  if (!accountIds.length) return;
  await Promise.allSettled(
    [...new Set(accountIds)].map((accountId) => {
      const id = env.REALTIME_MAILBOX.idFromName(accountId);
      return env.REALTIME_MAILBOX.get(id).fetch("https://voyager-call-realtime.local/notify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event)
      });
    })
  );
}

export class RealtimeMailbox {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/connect") return this.connect(request);
    if (url.pathname === "/notify") return this.notify(request);
    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    try {
      const payload = JSON.parse(message) as { type?: string; id?: string };
      if (payload.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", id: payload.id ?? null, createdAt: new Date().toISOString() }));
      }
    } catch {
      // Ignore malformed client keepalive frames. The socket stays open.
    }
  }

  webSocketClose(): void {
    // Hibernating WebSockets are removed by the platform.
  }

  webSocketError(): void {
    // The platform closes errored sockets; no persistent state is kept here.
  }

  private connect(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const accountId = requiredHeader(request, "x-voyager-account-id");
    const principalId = requiredHeader(request, "x-voyager-principal-id");
    const deviceId = requiredHeader(request, "x-voyager-device-id");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const attachment: SocketAttachment = {
      accountId,
      principalId,
      deviceId,
      connectedAt: new Date().toISOString()
    };
    server.serializeAttachment(attachment);
    this.state.acceptWebSocket(server, [`account:${accountId}`, `device:${deviceId}`]);
    server.send(
      JSON.stringify({
        type: "ready",
        accountId,
        principalId,
        deviceId,
        protocol: CALL_REALTIME_PROTOCOL,
        createdAt: attachment.connectedAt
      })
    );
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": CALL_REALTIME_PROTOCOL }
    });
  }

  private async notify(request: Request): Promise<Response> {
    const event = (await request.json()) as CallRealtimeEvent;
    const payload = JSON.stringify(event);
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        socket.close(1011, "send_failed");
      }
    }
    return new Response(null, { status: 202 });
  }
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (!value) throw new Error(`Missing realtime header: ${name}`);
  return value;
}
