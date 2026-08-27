import { getAuth } from "@/lib/auth";

/** Better Auth needs Node APIs (crypto, Prisma) — not the edge runtime. */
export const runtime = "nodejs";
/** Every auth request is request-specific; nothing here may be cached. */
export const dynamic = "force-dynamic";

async function handler(request: Request): Promise<Response> {
  return getAuth().handler(request);
}

export { handler as GET, handler as POST };
