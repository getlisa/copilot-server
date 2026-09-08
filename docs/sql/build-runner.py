"""Turn a .sql file into a self-contained node runner with the statements already split.

Called by apply-phase1b.sh. The split lives here, on the machine running the deploy, rather than
inside the container, for two reasons:

  - Prisma's `$executeRawUnsafe` takes ONE statement at a time, and a naive `split(';')` cuts
    every `DO $$ ... $$` block in half at its first inner semicolon. That needs a dollar-quote
    aware scanner, and shipping the scanner is pure payload.
  - The ECS container-override limit is 8192 bytes. Every byte of logic that stays here is a byte
    the override does not have to carry.

    Usage: python3 build-runner.py <sql file> <output .js>
"""

import json
import re
import sys


def statements(sql: str) -> list[str]:
    """Split on top-level semicolons, treating $tag$...$tag$ bodies as opaque."""
    out: list[str] = []
    buf, i, tag = "", 0, None
    while i < len(sql):
        if tag is None:
            m = re.match(r"\$[A-Za-z_]*\$", sql[i:])
            if m:
                tag = m.group(0)
                buf += tag
                i += len(tag)
                continue
            if sql.startswith("--", i):
                nl = sql.find("\n", i)
                i = len(sql) if nl == -1 else nl + 1
                continue
            if sql[i] == ";":
                if buf.strip():
                    out.append(buf.strip())
                buf = ""
                i += 1
                continue
            buf += sql[i]
            i += 1
        else:
            if sql.startswith(tag, i):
                buf += tag
                i += len(tag)
                tag = None
                continue
            buf += sql[i]
            i += 1
    if buf.strip():
        out.append(buf.strip())
    return out


RUNNER = """// The app's URL points at app_user, which cannot ALTER a postgres-owned table. Swap in the
// master credentials through the ENVIRONMENT, before @prisma/client is required — the env path is
// what Prisma reads by default and has no constructor API to get wrong across versions. This runs
// blind against production, where finding out costs a full ECS round-trip.
{
  const u = new URL(process.env.DIRECT_URL || process.env.DATABASE_URL);
  u.username = encodeURIComponent(process.env.PGMASTER_USER);
  u.password = encodeURIComponent(process.env.PGMASTER_PASSWORD);
  process.env.DATABASE_URL = process.env.DIRECT_URL = u.toString();
  console.log('connecting as', process.env.PGMASTER_USER, 'to', u.host + u.pathname);
}
const { PrismaClient } = require('@prisma/client');
const S = __STMTS__;
(async () => {
  const p = new PrismaClient();
  console.log('statements:', S.length);
  for (let n = 0; n < S.length; n++) {
    const first = S[n].split(String.fromCharCode(10))[0].slice(0, 90);
    try {
      await p.$executeRawUnsafe(S[n]);
      console.log('[' + (n + 1) + '/' + S.length + '] ok: ' + first);
    } catch (e) {
      console.error('[' + (n + 1) + '/' + S.length + '] FAILED: ' + first + ' :: ' + e.message);
      await p.$disconnect();
      process.exit(1);
    }
  }
  await p.$disconnect();
  console.log('PHASE1B_APPLIED');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
"""

if __name__ == "__main__":
    sql_path, out_path = sys.argv[1], sys.argv[2]
    stmts = statements(open(sql_path).read())
    if not stmts:
        raise SystemExit(f"no statements found in {sql_path}")
    open(out_path, "w").write(RUNNER.replace("__STMTS__", json.dumps(stmts)))
    print("statements:", len(stmts))
