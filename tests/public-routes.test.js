/*
 * Which routes an anonymous caller may reach.
 *
 * Written before making this repository public, because publishing the source
 * turns "nobody knows the endpoint exists" into no protection at all.
 *
 * A group of sales routes once ran behind optionalProtect and nothing else.
 * optionalProtect tries to authenticate and never refuses, so a caller who
 * simply did not authenticate carried on as anonymous - and the handlers, with
 * no session to read the branch from, took it from the request instead:
 * req.body.branch_id, req.query.branchId, req.body.order_id.
 *
 * The effect was that anyone who could reach the API could name any branch of
 * any shop and read its live data, its history, its catalogue and its printed
 * receipts. Some of those handlers accepted items, totals and discounts, so an
 * anonymous request could rewrite what another shop's sale said it cost.
 *
 * These tests fix the list of routes that may be reached without a session, and
 * require the rest to prove they are the shop's own equipment.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROUTES_DIR = path.join(__dirname, '..', 'api', 'src', 'routes');

/* Routes declared before a file's router.use(protect), i.e. reachable without
   a login session. */
function openRoutes(file) {
  const src = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
  const guardAt = (() => {
    const m = src.match(/router\.use\(\s*(protect|auth\b|authenticate\b)/);
    return m ? m.index : Infinity;
  })();

  /* Both quote styles. This matched only double quotes for months, and a
     route file written with single quotes - which is most of them - escaped
     the sweep entirely. A security test that inspects a dialect nobody
     writes is a security test in name. Found when a deliberately public
     route passed without being allowed. */
  return [...src.matchAll(/router\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']([^;]*)/g)]
    .filter((m) => m.index < guardAt)
    .map((m) => ({ method: m[1], route: m[2], middleware: m[3] }));
}

/*
 * The only routes that may be reached with no credential of any kind.
 *
 * Each is here for a stated reason. Adding to this list is a decision about
 * what strangers may do to a shop's data, so it should take a code review.
 * Routes that carry their own credential - a printer device key, a signed
 * one-use token, an emailed one-time key - are recognised by GUARDS below, not
 * listed here: they are not anonymous, they just authenticate differently.
 */
const ALLOWED_ANONYMOUS = {
  'business-access.routes.js': [
    // HTTPS-only metadata and rate-limited authorization entry points.
    // Approval verifies browser-bound consent, origin and active credentials;
    // token exchange verifies S256 proof and consumes a one-use request.
    // The remaining routes run behind their own guards and never accept POS JWTs.
    '/discovery', '/requests', '/authorize', '/approve', '/token',
  ],
  'recovery.routes.js': [
    // Installation-wide capability only, without account lookup; reset proves
    // ownership with a one-use 128-bit code, with its own persistent limiter.
    // Code generation/status stay behind protect and owner checks.
    '/options', '/reset',
  ],
  'users.routes.js': [
    // Invisible to this sweep for months: the file is single-quoted and the
    // sweep matched only double quotes. Reviewed on discovery - every one
    // is an auth ENTRY point or carries its own credential.
    '/register', '/login', '/verify',
    // key+secret travel IN the path - installation credentials
    '/ssoAuth', '/ssoToken/:key/:secret', '/planUpdate/:key/:secret',
    // the forgot-password flow: both require the emailed one-time user_key
    '/getUserKeyDetails', '/updateNewPassword',
  ],
  'client-errors.routes.js': [
    // The boot watchdog's report: the errors worth hearing about happen
    // BEFORE auth works. Stores nothing, per-IP budgeted, truncated,
    // always 204 - see the route file.
    '/',
    // TEMPORARY diagnostic window: the last 30 already-truncated report
    // lines, readable where no audited log path exists. Comes out with the
    // boot flight recorder once the startup crash is closed.
    '/recent',
  ],
  'settings.routes.js': [
    // Static reference data. No shop's information is in any of them.
    '/getJSONCountry', '/getJSONState', '/getJSONCurrency', '/getJSONTimeZone',
    '/forgotPassword',
  ],
  'pair.routes.js': [
    // The page a till shows so a staff phone can be pointed at this shop.
    // It carries an ADDRESS, not a credential - the same thing the till's own
    // browser address bar shows anybody standing at it. Requiring a login
    // would mean a device cannot be paired until somebody signs in on the
    // till, which is backwards: pairing is what happens before anyone can.
    '/',
  ],
  'base.routes.js': [
    // Liveness only. "/" says it is running; "/health" reports status, time and
    // uptime to a stranger and keeps the version, platform and memory figures
    // for callers who have logged in.
    '/', '/health',
  ],
};

/*
 * These guards all prove something before the handler runs. verifyInstallationCredentials
 * belongs here: the install routes are how a fresh machine registers itself,
 * before any user exists to log in as, and they check the per-installation key
 * and secret instead. The print-device and receipt-link guards are for the
 * shop's own equipment and bounded customer links, not for anonymous callers.
 */
const GUARDS =
  /(protect|ensurePrintDevice|protectDeviceDecision|customer-receipt-link|authenticate|verifyToken|verifyInstallationCredentials)/;

test('the route files are where the test thinks they are', () => {
  const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.routes.js'));
  assert.ok(files.length > 15, `only ${files.length} route files found`);
});

test('nothing reachable without a session is left unguarded', () => {
  const naked = [];

  for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.routes.js'))) {
    const allowed = ALLOWED_ANONYMOUS[file] || [];

    for (const { method, route, middleware } of openRoutes(file)) {
      if (allowed.includes(route)) continue;
      if (GUARDS.test(middleware)) continue;
      naked.push(`${file}  ${method.toUpperCase()} ${route}`);
    }
  }

  assert.deepStrictEqual(naked, [],
    'these are reachable with no credential at all. Either add a guard ' +
    '(protect, or the route\'s own device credential) or add them to ' +
    'ALLOWED_ANONYMOUS with the reason:\n  ' + naked.join('\n  '));
});

test('optionalProtect is never the only thing in front of a route', () => {
  /* This is the specific mistake that was made. optionalProtect authenticates
     when it can and lets everyone else through, so on its own it is not a
     guard - it only looks like one. */
  const lonely = [];

  for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.routes.js'))) {
    const src = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    for (const m of src.matchAll(/router\.\w+\(\s*"([^"]+)"\s*,\s*optionalProtect\s*,\s*(\w+)/g)) {
      if (!GUARDS.test(m[2])) lonely.push(`${file}  ${m[1]}  -> ${m[2]}`);
    }
  }

  assert.deepStrictEqual(lonely, [],
    'optionalProtect never returns 401, so it must be followed by a real ' +
    'guard:\n  ' + lonely.join('\n  '));
});

test('the routes that leaked are specifically closed', () => {
  /* Named one by one rather than left to the sweep above: these are the actual
     holes that were open, and each should fail loudly if it reopens. */
  const src = fs.readFileSync(path.join(ROUTES_DIR, 'sales.routes.js'), 'utf8');

  const MUST_BE_GUARDED = [
    ['/claimPrintJobs', /ensurePrintDevice/, "claiming another shop's print jobs"],
    ['/finishPrintJob', /ensurePrintDevice/, "finishing another shop's print jobs"],
    ['/printJobsNeedingAttention', /ensurePrintDevice/, "another shop's print queue"],
    ['/resolvePrintJob', /ensurePrintDevice/, "resolving another shop's print jobs"],
    ['/getCustomerPrint', /customer-receipt-link/, 'any sale receipt, with the customer on it'],
  ];

  /*
   * Read whole registrations, not lines.
   *
   * This used to scan for a line containing both `router.` and the
   * double-quoted path. Two things then broke it at once: Prettier prefers
   * single quotes, and it wraps a call this long across several lines - so
   * `router.get(`, the path and the guards each ended up on their own line.
   * Every route in this list looked as though it had vanished, which is the
   * most alarming way for a test to be wrong about a security check.
   *
   * Splitting on `router.` and taking each call up to its closing `);` reads
   * the same registration whatever shape the formatter leaves it in.
   */
  const calls = src
    .split(/\brouter\.(?=get|post|put|patch|delete|all)/)
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf(');') + 2));

  for (const [route, guard, what] of MUST_BE_GUARDED) {
    const quoted = new RegExp(`['"\`]${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
    const matching = calls.filter((c) => quoted.test(c));
    assert.ok(matching.length > 0, `${route} has vanished from the routes`);
    for (const call of matching) {
      assert.match(call, guard, `${route} is unguarded again - it exposes ${what}`);
    }
  }
});

test('the public health answer does not name the runtime', () => {
  /* An unauthenticated /health used to return process.version, the platform and
     the environment name - the exact list wanted by someone choosing which
     published Node vulnerability to try. */
  const src = fs.readFileSync(path.join(ROUTES_DIR, 'base.routes.js'), 'utf8');
  const health = src.search(/router\.get\(\s*['"`]\/health['"`]/);
  assert.ok(health >= 0, 'the /health route has gone or changed shape');
  const handler = src.slice(health);
  const body = handler.slice(0, handler.indexOf('\n});'));

  assert.match(body, /if \(req\.user\)/,
    'the detailed health payload is not gated on being signed in');

  const beforeGate = body.slice(0, body.indexOf('if (req.user)'));
  for (const leak of ['process.version', 'process.platform', 'NODE_ENV', 'memoryUsage']) {
    assert.ok(!beforeGate.includes(leak),
      `/health tells an anonymous caller ${leak}`);
  }
});

test('registration cannot be reached, or self-promoted, by a stranger', () => {
  /*
   * POST /auth/register sat above router.use(protect), and the handler passed
   * role straight from the request body into User.create. The schema's role
   * enum includes "admin" and "super_admin", and hasPermission returns true for
   * everything when role is "admin" - so an unauthenticated caller could name
   * themselves super_admin and be signed in as one. The API router is mounted
   * at both /api and /, so it was reachable twice over.
   *
   * Two independent things have to hold, because either alone is enough to be
   * bitten by: the route must not be anonymous, and the handler must not take a
   * role from whoever is asking.
   */
  const routes = fs.readFileSync(path.join(ROUTES_DIR, 'auth.routes.js'), 'utf8');
  const line = routes.split('\n').find((l) => /router\.post\(\s*['"`]\/register['"`]/.test(l));

  assert.ok(line, 'the register route has gone or changed shape');
  assert.match(line, /verifyInstallationCredentials|protect/,
    'POST /auth/register is anonymous again');

  const handler = fs.readFileSync(
    path.join(ROUTES_DIR, '..', 'controllers', 'auth.controller.js'), 'utf8');
  const create = handler.slice(handler.indexOf('exports.register'));
  const body = create.slice(0, create.indexOf('});'));

  for (const claimed of ['role', 'usertype', 'access', 'license']) {
    /* Double-escaped on purpose. In a TEMPLATE LITERAL "\\s" collapses to a
       bare "s" and "\\." to ".", so this pattern used to demand a literal
       letter s and treat the dot as "any character" - it would sail straight
       past "role: req.body.role", which is the exact line it exists to catch.
       A guard that cannot fail is worse than no guard, because it reads as
       one. */
    assert.ok(!new RegExp(`${claimed}:\\s*req\\.body\\.`).test(body),
      `register takes ${claimed} from the request body - privilege is granted, not claimed`);
  }
});
