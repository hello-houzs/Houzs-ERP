const STAGING_REF = "minnapsemfzjmtvnnvdd";
export const STAGING_ACK = "I_UNDERSTAND_THIS_LOADS_STAGING";
const PRODUCTION_REF = "anogrigyjbduyzclzjgn";

function decodedUsername(parsed) {
  try {
    return decodeURIComponent(parsed.username).toLowerCase();
  } catch {
    return "";
  }
}

export function assertPgTarget(url, acknowledgement = process.env.PERF_STAGING_ACK) {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  const username = decodedUsername(parsed);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
  if (local) return true;

  const productionIdentity =
    hostname === `db.${PRODUCTION_REF}.supabase.co`
    || (hostname.endsWith(".pooler.supabase.com") && username === `postgres.${PRODUCTION_REF}`)
    || hostname === "erp.houzscentury.com";
  if (productionIdentity) throw new Error("Refusing the known Houzs production target.");

  const directStaging = hostname === `db.${STAGING_REF}.supabase.co` && username === "postgres";
  const poolerStaging =
    hostname.endsWith(".pooler.supabase.com") && username === `postgres.${STAGING_REF}`;
  if ((!directStaging && !poolerStaging) || acknowledgement !== STAGING_ACK) {
    throw new Error(
      `Refusing a non-local Postgres target. Only the allowlisted Houzs staging project is accepted, with PERF_STAGING_ACK=${STAGING_ACK}.`,
    );
  }
  return false;
}
