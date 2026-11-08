// Jessica is available in protected Preview and the invite-only FirstHaven3 demo.
export const ANAM_DEMO_MAX_SECONDS = 180;
export const ANAM_DEMO_AVATAR_ID = 'b8b7eec3-4dd2-414a-820b-ec2815574502';

export function isAnamTesterDemo(env: Record<string, string | undefined>): boolean {
  return env.FIRST_HAVEN_ANAM_TESTER_DEMO === 'true' && (env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview');
}

export function isAnamDemo(env: Record<string, string | undefined>): boolean {
  return isAnamTesterDemo(env) || (env.VERCEL_ENV === 'preview' && env.FIRST_HAVEN_ANAM_PREVIEW === 'true');
}

export function allowsAnamTestReports(env: Record<string, string | undefined>): boolean {
  return isAnamDemo(env) && env.ANAM_TEST_REPORT_RETENTION === 'approved';
}
