export interface NsConfig {
  accountId: string;
  /** e.g. https://1234567-sb1.suitetalk.api.netsuite.com */
  restBaseUrl: string;
  /** e.g. https://1234567-sb1.restlets.api.netsuite.com */
  restletBaseUrl: string;
  tokenUrl: string;
  clientId: string;
  certId: string;
  maxConcurrency: number;
}

/** NetSuite hostnames use the account ID lowercased, with "_" replaced by "-" (1234567_SB1 -> 1234567-sb1). */
export function accountHost(accountId: string): string {
  const host = accountId.trim().toLowerCase().replace(/_/g, "-");
  if (!/^[a-z0-9-]+$/.test(host)) throw new Error(`Invalid NetSuite account ID: ${accountId}`);
  return host;
}

export function buildConfig(input: {
  accountId: string;
  clientId: string;
  certId: string;
  maxConcurrency?: number;
}): NsConfig {
  const host = accountHost(input.accountId);
  const restBaseUrl = `https://${host}.suitetalk.api.netsuite.com`;
  return {
    accountId: input.accountId,
    restBaseUrl,
    restletBaseUrl: `https://${host}.restlets.api.netsuite.com`,
    tokenUrl: `${restBaseUrl}/services/rest/auth/oauth2/v1/token`,
    clientId: input.clientId,
    certId: input.certId,
    maxConcurrency: input.maxConcurrency ?? 2,
  };
}

/** Reads configuration from environment variables. Only identifiers live here; the private key never does. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): NsConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
    return value;
  };
  const max = env.NS_MAX_CONCURRENCY?.trim();
  return buildConfig({
    accountId: required("NS_ACCOUNT_ID"),
    clientId: required("NS_CLIENT_ID"),
    certId: required("NS_CERT_ID"),
    maxConcurrency: max ? Number(max) : 2,
  });
}
