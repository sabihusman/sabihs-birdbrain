/**
 * This device in the account's bird list (DECISIONS.md #139): a random id made here and kept in localStorage, and a
 * name from the browser's user-agent string ("iPhone · Safari") so My account can tell devices apart. Nothing else
 * about the device is sent.
 */

const DEVICE_KEY = 'birdbrain.device.v1';

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** This device's id, made once. Without storage it is new every visit (the server then sees a new device each time). */
export function deviceId(storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): string {
  try {
    const had = storage?.getItem(DEVICE_KEY);
    if (had && /^[A-Za-z0-9-]{8,64}$/.test(had)) return had;
    const id = makeId();
    storage?.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return makeId();
  }
}

/** The kind of device, from the user-agent string. iPads that ask for desktop sites read as a Mac. */
function deviceKind(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows computer';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux/.test(ua)) return 'Linux computer';
  return 'Device';
}

/** The browser, from the user-agent string; the order matters (Edge and Chrome on iPhone also say "Safari"). */
function browserName(ua: string): string | null {
  if (/Edg(A|iOS)?\//.test(ua)) return 'Edge';
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/CriOS\/|Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return null;
}

/** "iPhone · Chrome", "Android phone · Firefox", "Mac · Safari"; at most 40 characters, as the server allows. */
export function deviceLabel(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const browser = browserName(ua);
  return (browser ? `${deviceKind(ua)} · ${browser}` : deviceKind(ua)).slice(0, 40);
}
