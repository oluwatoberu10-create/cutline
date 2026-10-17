/** Refuses to run destructive scripts against anything but a local database. */
export function isLocalUrl(url: string | undefined): boolean {
  return !url || url.includes("127.0.0.1") || url.includes("localhost");
}

export function assertLocal(script: string, overrideVar: string): void {
  if (isLocalUrl(process.env.DATABASE_URL)) return;
  if (process.env[overrideVar] === "true") {
    console.warn(`[${script}] ${overrideVar}=true — running against a REMOTE database.`);
    return;
  }
  console.error(
    `[${script}] refusing to run: DATABASE_URL is not local.\n` +
    `This script wipes data.\n` +
    `Set ${overrideVar}=true only if you are certain this is a throwaway database.`,
  );
  process.exit(1);
}
