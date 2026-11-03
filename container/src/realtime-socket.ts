import type { RealtimeHub } from "./realtime";
/** Socket.IO event handling kept separate from Bun's frame transport so auth,
 * replacements and disconnect races can be tested without opening a socket. */
export class RealtimeSocketSession {
 private client?: { id: string; username: string };
 private revision = 0;
 private disposed = false;
 constructor(private readonly id: string, private readonly hub: RealtimeHub,
  private readonly authenticate: (key: string) => Promise<{ id: string; username: string } | null>,
  private readonly send: (event: string, payload: any) => void,
  private readonly disconnect: (code: number, reason: string) => void) {}
 async receive(event: string, payload: any): Promise<void> {
  if (this.disposed) return;
  if (event === "authenticate" || event === "join") {
   const revision = ++this.revision;
   const key = typeof payload?.queryKey === "string" ? payload.queryKey : "";
   const client = key ? await this.authenticate(key) : null;
   if (this.disposed || revision !== this.revision) return;
   if (!client || (payload?.username !== undefined && payload.username !== client.username)
    || (this.client && this.client.id !== client.id)) {
    this.send("authenticated", { success: false }); this.close(); this.disconnect(4001, "unauthorized"); return;
   }
   this.client = client;
   this.send("authenticated", { success: true, username: client.username });
   this.send("subscribedToUsername", JSON.stringify({ username: client.username, success: true }));
   this.hub.addSocket(client.id, this.id, this.send);
   return;
  }
  if (event !== "subscribe" && event !== "pioneer:subscribe" && event !== "unsubscribe") return;
  if (!this.client) { this.send("subscription:error", { success: false, message: "Authenticate before subscribing" }); return; }
  try {
   if (event === "unsubscribe") { this.hub.unsubscribeSocket(this.client.id, this.id); this.send("unsubscribed", { success: true }); }
   else this.hub.subscribeSocket(this.client.id, this.id, payload?.addresses, payload?.events, { since: payload?.since, walletScope: payload?.walletScope });
  } catch { this.send("subscription:error", { success: false, message: "Invalid watch subscription" }); }
 }
 close(): void { if (this.disposed) return; this.disposed = true; this.revision++; this.hub.removeSocket(this.client?.id, this.id); }
}
