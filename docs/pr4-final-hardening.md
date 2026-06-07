# PR4 Final Backend Hardening

Status: implementation notes
Date: 2026-06-07

## 1. Purpose

This pass closes the remaining backend handoff blockers found after the PR4 security follow-up. The goal is not to freeze the public `v1` API yet. The goal is to make the backend safer for the next contract/schema pass by tightening privileged account boundaries, one-time token lifecycles, group membership semantics, and automated regression coverage.

The backend remains backend-first. Deferred work still includes mobile builds, app stores, push services, production signing, billing, paid plans, hosted AI runtimes, encrypted cloud backups, public custom domains, and other external dependencies outside the Cloudflare backend substrate.

## 2. Decisions

- Any account with an active admin role is protected from non-platform-owner account administration.
- Lower administrators may still suspend, restore, or credential-reset ordinary non-admin user accounts.
- Only platform owners may reset, suspend, restore, policy-change, role-manage, or otherwise take control of an account that has any active admin role.
- Credential reset completion computes the password hash before D1 mutation, then uses an operation-specific `used_at` marker to gate all reset mutations on the successful token claim.
- Account invitation acceptance computes the password hash before D1 mutation, then uses an operation-specific `accepted_at` marker to gate authenticator creation and account activation on the successful invitation claim.
- Conditional D1 updates that affect zero rows are treated as failed claims by checking affected-row counts after the batch.
- Device and session creation happen after successful account activation. If those post-activation steps fail, the user can retry login or enrollment with the new password.
- Group creation rejects `memberPrincipalIds` with a validation error. Groups begin with the creator as owner only.
- Human group members join through room invitations. Agent principals are added through the explicit room member endpoint.
- Pull requests must run an automated backend authorization and lifecycle smoke suite, not just TypeScript checks.

## 3. Technical Notes

Cloudflare D1 `batch()` runs statements sequentially as a transaction, but a conditional `UPDATE` that changes zero rows is still a successful SQL statement. For that reason, token claims in this pass do not rely on batch placement alone.

The invitation and credential-reset flows use a unique timestamp marker for the operation. Later statements in the same batch require that exact marker to be present on the invitation or reset token row. If the initial claim changes zero rows, later gated statements cannot mutate the account or authenticators. The code then verifies the expected affected-row counts before creating the replacement device and session.

## 4. Regression Coverage

The backend smoke path now covers:

- lower admin can administer ordinary user accounts;
- lower admin cannot administer accounts with active admin roles;
- invitation activation tokens are one-time use;
- credential reset replacement tokens revoke older unused reset tokens;
- credential reset tokens are one-time use;
- suspended accounts cannot complete credential reset;
- group creation rejects initial `memberPrincipalIds`;
- humans join group rooms through invitations;
- human direct member insertion remains rejected after group creation;
- agent direct-add still succeeds;
- cross-account device revocation remains blocked;
- removed or unauthorized principals cannot send into rooms they do not belong to.

## 5. Next Backend Step

The next backend-focused pass should add shared TypeScript API contracts, formal request and response schemas, and endpoint documentation. After that, the initial frontend-facing `v1` contract can be frozen for desktop UI work.
