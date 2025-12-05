import * as dotenv from 'dotenv';

dotenv.config();

function requireEnv(key: string, defaultValue: string): string {
  return (process.env[key] ?? defaultValue) as string;
}

export const jwtConfig = {
  accessSecret: requireEnv('JWT_ACCESS_SECRET', 'your-access-secret-change-in-production'),
  refreshSecret: requireEnv('JWT_REFRESH_SECRET', 'your-refresh-secret-change-in-production'),
  accessExpiresIn: requireEnv('JWT_ACCESS_EXPIRES_IN', '15m'),
  refreshExpiresIn: requireEnv('JWT_REFRESH_EXPIRES_IN', '7d'),
};
