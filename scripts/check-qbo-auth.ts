import assert from "assert";

/**
 * Pins the QuickBooks AUTH contract (Clara-owned Intuit app, 2026-09-04). Companion to
 * check-qbo.ts, which pins the estimate line mapping.
 *
 * What is worth pinning here is the stuff that fails silently or dangerously in production:
 *  - who counts as an admin (service_manager does — the frontend used to think otherwise);
 *  - that a connection minted under the OTHER Intuit keyset reads as "reconnect", not "connected",
 *    so a sandbox→production flip cannot quietly post real quotes into a test company;
 *  - that the consent URL carries the caller's company in a SIGNED state, and that a tampered or
 *    foreign-signed state resolves to nothing (this is the whole defence of the callback);
 *  - that the server refuses to look configured when the token key is missing — a connection that
 *    only fails after the client has granted consent at Intuit is the worst place to find out.
 *
 * Env is set BEFORE importing lib/qbo.ts because that module reads process.env at load.
 */

process.env.QBO_CLIENT_ID = "test-client-id";
process.env.QBO_CLIENT_SECRET = "test-client-secret";
process.env.QBO_REDIRECT_URI = "https://example.test/api/v1/companies/connections/qbo/callback";
process.env.QBO_ENVIRONMENT = "sandbox";
process.env.QBO_TOKEN_KEY = "unit-test-token-key";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "unit-test-jwt-secret";

async function main() {
  const { isAdminRole, ADMIN_ROLES } = await import("../src/api/middlewares/auth");
  const { qboAuthUrl, companyIdFromState, qboConnected, qboReconnectRequired, isQboConfigured, QBO_ENVIRONMENT } =
    await import("../src/lib/qbo");
  const jwt = (await import("jsonwebtoken")).default;

  // ---- roles (D2/D3) ----
  assert.strictEqual(isAdminRole("admin"), true);
  assert.strictEqual(isAdminRole("service_manager"), true, "service_manager is an admin for settings");
  assert.strictEqual(isAdminRole("technician"), false);
  assert.strictEqual(isAdminRole(undefined), false);
  assert.strictEqual(isAdminRole(""), false);
  assert.deepStrictEqual([...ADMIN_ROLES].sort(), ["admin", "service_manager"]);

  // ---- environment stamp ----
  assert.strictEqual(QBO_ENVIRONMENT, "sandbox", "env var selects the keyset");
  const conn = (environment: string, encryptedAuth: string | null, realmId: string | null = "9341455474664217") =>
    ({ environment, encryptedAuth, realmId } as any);

  assert.strictEqual(qboConnected(conn("sandbox", "sealed")), true);
  assert.strictEqual(qboConnected(conn("sandbox", null)), false, "no tokens = not connected");
  assert.strictEqual(qboConnected(null), false);
  // The flip: tokens minted by the production keyset while this server runs sandbox.
  assert.strictEqual(
    qboConnected(conn("production", "sealed")),
    false,
    "tokens from the other keyset must NOT read as connected"
  );
  assert.strictEqual(qboReconnectRequired(conn("production", "sealed")), true);
  assert.strictEqual(qboReconnectRequired(conn("sandbox", "sealed")), false);
  assert.strictEqual(qboReconnectRequired(conn("production", null)), false, "never connected != reconnect");
  // Tokens without a realm cannot post anything. Reporting Connected would surface the failure
  // at quote completion instead of on the Connections card where Reconnect lives.
  assert.strictEqual(
    qboConnected(conn("sandbox", "sealed", null)),
    false,
    "tokens with no realm must not read as connected"
  );

  // ---- consent URL + signed state ----
  const url = new URL(qboAuthUrl(42));
  assert.strictEqual(url.origin + url.pathname, "https://appcenter.intuit.com/connect/oauth2");
  assert.strictEqual(url.searchParams.get("client_id"), "test-client-id", "Clara's app key, not a per-company one");
  assert.strictEqual(url.searchParams.get("redirect_uri"), process.env.QBO_REDIRECT_URI);
  assert.strictEqual(url.searchParams.get("response_type"), "code");
  assert.strictEqual(url.searchParams.get("scope"), "com.intuit.quickbooks.accounting");

  const state = url.searchParams.get("state")!;
  assert.ok(state, "consent URL must carry a state");
  assert.strictEqual(companyIdFromState(state), 42, "state round-trips the company id");
  assert.notStrictEqual(state, "42", "state must be signed, never a bare company id");

  // A state signed with someone else's secret, or edited, must not resolve to a company —
  // this is what stops a forged callback attaching a QuickBooks account to another company.
  const forged = jwt.sign({ qbo: 99 }, "not-the-server-secret", { expiresIn: "15m" });
  assert.strictEqual(companyIdFromState(forged), null, "foreign-signed state is rejected");
  assert.strictEqual(companyIdFromState(state.slice(0, -2) + "xy"), null, "tampered state is rejected");
  assert.strictEqual(companyIdFromState("garbage"), null);
  const expired = jwt.sign({ qbo: 42 }, process.env.JWT_ACCESS_SECRET!, { expiresIn: -60 });
  assert.strictEqual(companyIdFromState(expired), null, "expired state is rejected");

  // Distinct companies get distinguishable states.
  assert.strictEqual(companyIdFromState(new URL(qboAuthUrl(7)).searchParams.get("state")!), 7);

  // ---- configured matrix ----
  assert.strictEqual(isQboConfigured(), true);
  const saved = process.env.QBO_TOKEN_KEY;
  delete process.env.QBO_TOKEN_KEY;
  assert.strictEqual(
    isQboConfigured(),
    false,
    "without a token key the server must not offer to connect — sealing would throw AFTER consent"
  );
  process.env.QBO_TOKEN_KEY = saved;
  assert.strictEqual(isQboConfigured(), true);

  // ---- the route table actually enforces the roles ----
  // This replaces a loop that re-asserted isAdminRole and would have passed even if the
  // controller hard-coded canManage: true. What needs pinning is the WIRING — drop requireAdmin
  // from a write route and a technician can rewrite the percentage applied to customer money.
  const { companyRoute } = await import("../src/api/routes/company.route");
  const routes = (companyRoute as unknown as { stack: any[] }).stack
    .filter((l) => l.route)
    .map((l) => ({
      method: Object.keys(l.route.methods)[0],
      path: l.route.path,
      handlers: l.route.stack.map((h: { name: string }) => h.name),
    }));

  const find = (method: string, path: string) => {
    const r = routes.find((x) => x.method === method && x.path === path);
    assert.ok(r, `route ${method.toUpperCase()} ${path} is missing`);
    return r!;
  };

  for (const [method, path] of [
    ["post", "/sales-tax"],
    ["put", "/sales-tax/default"],
    ["post", "/connections/qbo/connect"],
    ["delete", "/connections/qbo"],
    ["put", "/markup"],
  ] as [string, string][]) {
    const r = find(method, path);
    assert.ok(r.handlers.includes("authMiddleware"), `${path} must authenticate`);
    assert.ok(r.handlers.includes("requireAdmin"), `${path} must be admin-only`);
  }

  // Open to every role, deliberately: an estimate has to show the rate it applies, and a
  // technician picks the customer. Gating either empties the screen with no error anywhere.
  for (const [method, path] of [
    ["get", "/sales-tax"],
    ["get", "/qbo/customers"],
    ["get", "/connections/qbo/items"],
  ] as [string, string][]) {
    const r = find(method, path);
    assert.ok(r.handlers.includes("authMiddleware"), `${path} must still authenticate`);
    assert.ok(
      !r.handlers.includes("requireAdmin"),
      `${path} must NOT be admin-only — technicians need it`
    );
  }

  // The OAuth callback is the one unauthenticated route; its credential is the signed state.
  assert.ok(
    !find("get", "/connections/qbo/callback").handlers.includes("authMiddleware"),
    "Intuit redirects a browser here with no bearer token"
  );

  console.log("check-qbo-auth: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
