import { PrismaClient } from "@prisma/client";
import url from "url";

// Global singleton for Prisma Client
// Prevents multiple instances in development (hot reload) and production

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

const appendPgBouncerSafeParams = (rawUrl?: string) => {
  if (!rawUrl) return rawUrl;
  try {
    const parsed = new url.URL(rawUrl);
    // Add pgbouncer flag to disable prepared statements when going through transaction poolers
    if (!parsed.searchParams.has("pgbouncer")) {
      parsed.searchParams.append("pgbouncer", "true");
    }
    // Be conservative with connection concurrency when behind poolers
    if (!parsed.searchParams.has("connection_limit")) {
      parsed.searchParams.append("connection_limit", "1");
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
};

const datasourceUrl = appendPgBouncerSafeParams(process.env.DATABASE_URL);

export const prisma =
  global.prisma ||
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "info", "warn", "error"]
        : ["error"],
    datasources: {
      db: datasourceUrl ? { url: datasourceUrl } : undefined,
    },
  });

if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}

export default prisma;

