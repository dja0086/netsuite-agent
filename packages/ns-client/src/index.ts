export { M2MTokenProvider, type M2MTokenProviderOptions, type SigningAlg } from "./auth/oauth2-m2m";
export { accountHost, buildConfig, configFromEnv, type NsConfig } from "./config";
export { NsHttpError, isThrottle, parseNsError } from "./errors";
export { GovernanceLimiter, type LimiterOptions, type LimiterStats } from "./governance/limiter";
export { NsClient, type NsBase, type NsClientOptions, type NsRequest, type NsRequester, type TokenSource } from "./http";
export {
  MetadataCache,
  assertRecordId,
  assertRecordType,
  createRecord,
  describeRecordSchema,
  getRecord,
  listRecordTypes,
  summarizeSchema,
  type FieldSummary,
} from "./rest/record";
export {
  SUITEQL_MAX_PAGE,
  SUITEQL_MAX_RESULTS,
  collect,
  suiteql,
  suiteqlAll,
  suiteqlOffset,
  type Row,
  type SuiteQLPage,
} from "./rest/suiteql";
export { callRestlet, type RestletCall } from "./restlet";
export { FileSecretsBackend, secretsFromEnv, type SecretName, type SecretsBackend } from "./secrets";
export { stripLinks } from "./strip-links";
