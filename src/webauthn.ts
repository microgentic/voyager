import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from "@simplewebauthn/server";
import { base64UrlToBytes, bytesToBase64Url } from "./crypto";
import {
  createDeviceForPrincipal,
  createSession,
  createWebAuthnChallenge,
  getAccount,
  getActiveAccountByEmail,
  getLatestWebAuthnChallenge,
  getPasskeyAuthenticatorByCredentialId,
  getPrincipal,
  listPasskeyAuthenticators,
  markWebAuthnChallengeUsed,
  storePasskeyAuthenticator,
  updatePasskeyAuthenticatorAfterLogin,
  type PasskeyAuthenticatorRow
} from "./db";
import { HttpError, readJsonObject, stringField } from "./http";
import type { AccountRow, AuthContext, DeviceInput, DeviceRow, Env, PrincipalRow } from "./types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const encoder = new TextEncoder();

type RegistrationResponse = Parameters<typeof verifyRegistrationResponse>[0]["response"];
type AuthenticationResponse = Parameters<typeof verifyAuthenticationResponse>[0]["response"];
type VerificationCredential = Parameters<typeof verifyAuthenticationResponse>[0]["credential"];
type RegistrationUserId = NonNullable<Parameters<typeof generateRegistrationOptions>[0]["userID"]>;
type CredentialDescriptor = NonNullable<Parameters<typeof generateAuthenticationOptions>[0]["allowCredentials"]>[number];
type Transport = NonNullable<CredentialDescriptor["transports"]>[number];

const VALID_TRANSPORTS = new Set(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);

export async function createPasskeyRegistrationOptions(
  env: Env,
  url: URL,
  auth: AuthContext
): Promise<{ options: unknown; challengeExpiresAt: string; rpId: string; origin: string }> {
  const config = webAuthnConfig(env, url);
  const passkeys = await listPasskeyAuthenticators(env, auth.account.account_id);
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userID: encoder.encode(auth.account.account_id).slice() as RegistrationUserId,
    userName: auth.account.email ?? auth.account.account_id,
    userDisplayName: auth.account.display_name,
    timeout: 60_000,
    attestationType: "none",
    excludeCredentials: passkeys.map(credentialDescriptor),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required"
    }
  });
  const challenge = await createWebAuthnChallenge(env, auth.account.account_id, "registration", options.challenge);
  return { options, challengeExpiresAt: challenge.expires_at, rpId: config.rpId, origin: config.origin };
}

export async function verifyPasskeyRegistration(
  env: Env,
  request: Request,
  url: URL,
  auth: AuthContext
): Promise<{ authenticatorId: string; credentialId: string; createdAt: string }> {
  const body = await readJsonObject(request);
  const response = webAuthnRegistrationResponse(body);
  const config = webAuthnConfig(env, url);
  const challenge = await getLatestWebAuthnChallenge(env, auth.account.account_id, "registration");

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpId,
      requireUserVerification: true
    });
  } catch {
    throw new HttpError(400, "invalid_passkey_response", "Passkey registration response could not be verified");
  }

  if (!verification.verified) {
    throw new HttpError(400, "invalid_passkey_response", "Passkey registration response could not be verified");
  }

  const { registrationInfo } = verification;
  const credential = registrationInfo.credential;
  const transports = normalizeTransports(response.response.transports);
  const authenticator = await storePasskeyAuthenticator(env, {
    accountId: auth.account.account_id,
    credentialId: credential.id,
    publicKey: bytesToBase64Url(credential.publicKey),
    counter: credential.counter,
    publicCredentialData: {
      credentialId: credential.id,
      transports,
      aaguid: registrationInfo.aaguid,
      attestationFormat: registrationInfo.fmt,
      credentialDeviceType: registrationInfo.credentialDeviceType,
      credentialBackedUp: registrationInfo.credentialBackedUp,
      userVerified: registrationInfo.userVerified,
      origin: registrationInfo.origin,
      rpId: registrationInfo.rpID ?? config.rpId
    }
  });
  await markWebAuthnChallengeUsed(env, challenge.challenge_id);
  return {
    authenticatorId: authenticator.authenticator_id,
    credentialId: authenticator.webauthn_credential_id,
    createdAt: authenticator.created_at
  };
}

export async function createPasskeyLoginOptions(
  env: Env,
  request: Request,
  url: URL
): Promise<{ options: unknown; challengeExpiresAt: string; rpId: string; origin: string }> {
  const body = await readJsonObject(request);
  const email = stringField(body, "email", { required: true, max: 254, pattern: EMAIL_PATTERN })!;
  const account = await getActiveAccountByEmail(env, email);
  if (!account) {
    throw invalidPasskeyCredentials();
  }

  const passkeys = await listPasskeyAuthenticators(env, account.account_id);
  if (passkeys.length === 0) {
    throw invalidPasskeyCredentials();
  }

  const config = webAuthnConfig(env, url);
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    allowCredentials: passkeys.map(credentialDescriptor),
    timeout: 60_000,
    userVerification: "required"
  });
  const challenge = await createWebAuthnChallenge(env, account.account_id, "authentication", options.challenge);
  return { options, challengeExpiresAt: challenge.expires_at, rpId: config.rpId, origin: config.origin };
}

export async function verifyPasskeyLogin(
  env: Env,
  request: Request,
  url: URL
): Promise<{
  account: AccountRow;
  principal: PrincipalRow;
  device: DeviceRow;
  sessionToken: string;
  authenticatorId: string;
}> {
  const body = await readJsonObject(request);
  const response = webAuthnAuthenticationResponse(body);
  const credentialId = response.id || response.rawId;
  const authenticator = credentialId ? await getPasskeyAuthenticatorByCredentialId(env, credentialId) : null;
  if (!authenticator) {
    throw invalidPasskeyCredentials();
  }

  const account = await accountForPasskeyLogin(env, body, authenticator);
  const config = webAuthnConfig(env, url);
  const challenge = await getLatestWebAuthnChallenge(env, account.account_id, "authentication");

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpId,
      credential: verificationCredential(authenticator),
      requireUserVerification: true
    });
  } catch {
    throw invalidPasskeyCredentials();
  }

  if (!verification.verified) {
    throw invalidPasskeyCredentials();
  }

  const existingData = passkeyCredentialData(authenticator);
  await markWebAuthnChallengeUsed(env, challenge.challenge_id);
  await updatePasskeyAuthenticatorAfterLogin(env, {
    authenticatorId: authenticator.authenticator_id,
    counter: verification.authenticationInfo.newCounter,
    publicCredentialData: {
      ...existingData,
      credentialId: verification.authenticationInfo.credentialID,
      credentialDeviceType: verification.authenticationInfo.credentialDeviceType,
      credentialBackedUp: verification.authenticationInfo.credentialBackedUp,
      userVerified: verification.authenticationInfo.userVerified,
      lastOrigin: verification.authenticationInfo.origin,
      lastRpId: verification.authenticationInfo.rpID
    }
  });

  if (!account.default_principal_id) {
    throw new HttpError(500, "missing_principal", "Account is missing its default principal");
  }
  const principal = await getPrincipal(env, account.default_principal_id);
  const device = await createDeviceForPrincipal(env, account.account_id, principal.principal_id, deviceInput(body));
  const sessionToken = await createSession(env, account.account_id, device.device_id);
  return { account, principal, device, sessionToken, authenticatorId: authenticator.authenticator_id };
}

function webAuthnConfig(env: Env, url: URL): { rpName: string; rpId: string; origin: string } {
  return {
    rpName: env.WEBAUTHN_RP_NAME?.trim() || "Voyager",
    rpId: normalizeRpId(env.WEBAUTHN_RP_ID, url),
    origin: normalizeOrigin(env.WEBAUTHN_ORIGIN, url)
  };
}

function normalizeOrigin(value: string | undefined, url: URL): string {
  if (!value?.trim()) return url.origin;
  try {
    return new URL(value).origin;
  } catch {
    throw new HttpError(500, "webauthn_misconfigured", "WEBAUTHN_ORIGIN must be a valid origin URL");
  }
}

function normalizeRpId(value: string | undefined, url: URL): string {
  const trimmed = value?.trim();
  if (!trimmed) return url.hostname;
  if (trimmed.includes("://")) {
    try {
      return new URL(trimmed).hostname;
    } catch {
      throw new HttpError(500, "webauthn_misconfigured", "WEBAUTHN_RP_ID must be a valid domain");
    }
  }
  return trimmed;
}

async function accountForPasskeyLogin(
  env: Env,
  body: Record<string, unknown>,
  authenticator: PasskeyAuthenticatorRow
): Promise<AccountRow> {
  const requestedEmail = stringField(body, "email", { max: 254, pattern: EMAIL_PATTERN });
  if (requestedEmail) {
    const requestedAccount = await getActiveAccountByEmail(env, requestedEmail);
    if (!requestedAccount || requestedAccount.account_id !== authenticator.account_id) {
      throw invalidPasskeyCredentials();
    }
    return requestedAccount;
  }

  const account = await getAccount(env, authenticator.account_id);
  if (account.status !== "active") {
    throw invalidPasskeyCredentials();
  }
  return account;
}

function credentialDescriptor(authenticator: PasskeyAuthenticatorRow): CredentialDescriptor {
  return {
    id: authenticator.webauthn_credential_id,
    transports: passkeyTransports(authenticator)
  };
}

function verificationCredential(authenticator: PasskeyAuthenticatorRow): VerificationCredential {
  return {
    id: authenticator.webauthn_credential_id,
    publicKey: base64UrlToBytes(authenticator.webauthn_public_key).slice() as VerificationCredential["publicKey"],
    counter: Number(authenticator.webauthn_counter),
    transports: passkeyTransports(authenticator)
  };
}

function webAuthnRegistrationResponse(body: Record<string, unknown>): RegistrationResponse {
  return webAuthnCredentialResponse(body) as unknown as RegistrationResponse;
}

function webAuthnAuthenticationResponse(body: Record<string, unknown>): AuthenticationResponse {
  return webAuthnCredentialResponse(body) as unknown as AuthenticationResponse;
}

function webAuthnCredentialResponse(body: Record<string, unknown>): Record<string, unknown> {
  if (isCredentialResponse(body)) {
    return body;
  }
  const wrapped = body.response;
  if (isRecord(wrapped) && isCredentialResponse(wrapped)) {
    return wrapped;
  }
  throw new HttpError(400, "invalid_passkey_response", "Passkey response is missing credential fields");
}

function isCredentialResponse(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    typeof value.rawId === "string" &&
    value.type === "public-key" &&
    isRecord(value.response) &&
    isRecord(value.clientExtensionResults)
  );
}

function deviceInput(body: Record<string, unknown>): DeviceInput {
  return isRecord(body.device) ? body.device : {};
}

function passkeyTransports(authenticator: PasskeyAuthenticatorRow): Transport[] | undefined {
  return normalizeTransports(passkeyCredentialData(authenticator).transports);
}

function normalizeTransports(value: unknown): Transport[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const transports = value.filter((entry): entry is Transport => typeof entry === "string" && VALID_TRANSPORTS.has(entry));
  return transports.length > 0 ? transports : undefined;
}

function passkeyCredentialData(authenticator: PasskeyAuthenticatorRow): Record<string, unknown> {
  if (!authenticator.public_credential_data) return {};
  try {
    const parsed: unknown = JSON.parse(authenticator.public_credential_data);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidPasskeyCredentials(): HttpError {
  return new HttpError(401, "invalid_credentials", "Invalid credentials");
}
