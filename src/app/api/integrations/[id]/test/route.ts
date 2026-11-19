import { connection } from "next/server";
import { handle } from "@/lib/server/http";
import { testIntegration } from "@/lib/server/integrations";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  return handle(async () => {
    return await testIntegration(id);
  });
}
