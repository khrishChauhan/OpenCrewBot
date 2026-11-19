import { connection } from "next/server";
import { handle } from "@/lib/server/http";
import { listIntegrations } from "@/lib/server/integrations";

export async function GET() {
  await connection();
  return handle(async () => {
    return { integrations: await listIntegrations() };
  });
}
