import { ConfidentialClientApplication } from "@azure/msal-node";
import { cfg, secret, SECRETS } from "./config";
import { createRemoteJWKSet, jwtVerify, JWTPayload } from "jose";

// ---- Outbound: Entra token (certificate credential) -------------------------
let cca: ConfidentialClientApplication | undefined;

async function client(): Promise<ConfidentialClientApplication> {
  if (cca) return cca;
  const pem = await secret(SECRETS.certPem);
  const sha256 = await secret(SECRETS.certSha256);
  const key = pem.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/)?.[0];
  const cert = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  if (!key || !cert) throw new Error("Certificate PEM secret is malformed");
  cca = new ConfidentialClientApplication({
    auth: {
      clientId: cfg.clientId(),
      authority: `https://login.microsoftonline.com/${cfg.tenantId()}`,
      clientCertificate: { thumbprintSha256: sha256, privateKey: key, x5c: cert },
    },
  });
  return cca;
}

export async function getToken(scope: string): Promise<string> {
  const r = await (await client()).acquireTokenByClientCredential({ scopes: [scope] });
  if (!r?.accessToken) throw new Error(`No token for ${scope}`);
  return r.accessToken; // MSAL caches until near expiry
}

// ---- Inbound: validate Entra JWT from D365 / custom connector ----------------
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export class AuthError extends Error {}

export async function validateBearer(authHeader: string | null): Promise<JWTPayload> {
  if (!authHeader?.startsWith("Bearer ")) throw new AuthError("missing bearer");
  const token = authHeader.slice(7);
  const tid = cfg.tenantId();
  jwks ??= createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tid}/discovery/v2.0/keys`));
  const { payload } = await jwtVerify(token, jwks, {
    issuer: [`https://login.microsoftonline.com/${tid}/v2.0`, `https://sts.windows.net/${tid}/`],
    audience: cfg.allowedAudiences(),
    clockTolerance: 300,
  });
  if (payload.tid !== tid) throw new AuthError("tenant mismatch");
  return payload;
}

/** Webhook from D365: app-only token issued to the adapter app itself (FIC). */
export async function validateD365Webhook(authHeader: string | null): Promise<JWTPayload> {
  const p = await validateBearer(authHeader);
  const caller = (p.azp ?? p.appid) as string | undefined;
  if (caller !== cfg.clientId()) throw new AuthError(`unexpected caller ${caller}`);
  return p;
}
