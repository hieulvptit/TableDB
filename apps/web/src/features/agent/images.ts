export const MAX_IMAGES = 3;
const MAX_SIDE = 1600;
const MAX_CHARS = 600_000;   // keeps the request under the API body limit (data URL length)

/** Downscale to MAX_SIDE and re-encode as JPEG on a white background; lowers quality until the data URL fits MAX_CHARS. */
export async function fileToDataUrl(file: Blob): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * k)); canvas.height = Math.max(1, Math.round(bmp.height * k));
  const g = canvas.getContext('2d');
  if (!g) throw new Error('no canvas');
  g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  for (let q = 0.85; q >= 0.4; q -= 0.15) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (url.length <= MAX_CHARS) return url;
  }
  throw new Error('image too large');
}

export const imageFiles = (list: DataTransfer | FileList | null | undefined): File[] =>
  Array.from(list && 'files' in list ? list.files : (list as FileList | null) ?? []).filter((f) => f.type.startsWith('image/'));
