import * as dotenv from 'dotenv';

dotenv.config();

function requireEnv(key: string, defaultValue: string): string {
  return (process.env[key] ?? defaultValue) as string;
}

export const jwtConfig = {
  accessSecret: requireEnv('JWT_ACCESS_SECRET', 'your-access-secret-change-in-production'),
  refreshSecret: requireEnv('JWT_REFRESH_SECRET', 'your-refresh-secret-change-in-production'),
  // Tokens are SIGNED by the external login service — this server only verifies.
  // Set JWT_ACCESS_EXPIRES_IN=7d there too; this value is documentation of that contract.
  accessExpiresIn: requireEnv('JWT_ACCESS_EXPIRES_IN', '7d'),
  refreshExpiresIn: requireEnv('JWT_REFRESH_EXPIRES_IN', '7d'),
};
