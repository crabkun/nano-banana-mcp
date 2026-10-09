const SAFE_URL = /^[A-Za-z0-9_\-.~%=&?/:]+$/;

export function buildUploadCommand(uploadUrl: string | null, allowedHost: string): string | null {
  if (!uploadUrl || !SAFE_URL.test(uploadUrl)) return null;
  let url: URL;
  try {
    url = new URL(uploadUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.host !== allowedHost) return null;
  return `curl -sS '${uploadUrl}' -H 'X-Goog-Upload-Offset: 0' -H 'X-Goog-Upload-Command: upload, finalize' --data-binary @<IMAGE_PATH>`;
}
