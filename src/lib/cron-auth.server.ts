import { timingSafeEqual } from "crypto";

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

/** Compara em tempo constante (não vaza, pelo tempo, quantos caracteres batem). */
export function safeEqual(given: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Única checagem das rotas de cron: cabeçalho x-cron-token contra o token de cron_config. */
export async function verifyCronToken(request: Request, admin: Admin): Promise<boolean> {
  const given = request.headers.get("x-cron-token") ?? "";
  const { data } = await admin.from("cron_config").select("token").eq("id", 1).maybeSingle();
  return safeEqual(given, data?.token ?? "");
}
