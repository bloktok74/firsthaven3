// Jessica is restricted to the protected FirstHaven3 Preview.
export const ANAM_DEMO_MAX_SECONDS = 180;
export const ANAM_DEMO_AVATAR_ID = 'b8b7eec3-4dd2-414a-820b-ec2815574502';

export function isAnamDemo(env: Record<string, string | undefined>): boolean {
  return env.VERCEL_ENV === 'preview' && env.FIRST_HAVEN_ANAM_PREVIEW === 'true';
}
