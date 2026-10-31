// Environment detection, per-OS setup steps, and plain-language explanations for
// Web Bluetooth problems. No DOM access here; app.js renders what these return.

// Shown in the lower-right corner and in Settings. Bump it (and CACHE in sw.js) with every release.
export const APP_VERSION = '1.8.0';

/** Where the project lives (changelog, issues). A fork served from <user>.github.io/<repo>/ links to itself. */
export const REPO_URL = 'https://github.com/kyles0623/gvm-show-control';
export function repoUrl(loc = globalThis.location ?? {}) {
  const m = /^([a-z0-9-]+)\.github\.io$/i.exec(loc.hostname ?? '');
  const repo = (loc.pathname ?? '').split('/').filter(Boolean)[0];
  return m && repo ? `https://github.com/${m[1]}/${repo}` : REPO_URL;
}

/** Detects OS, browser and Web Bluetooth readiness. */
export function detectEnv(nav = navigator, win = window) {
  const ua = nav.userAgent ?? '';
  const brands = (nav.userAgentData?.brands ?? []).map((b) => b.brand);
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
  const os = isIOS ? 'ios'
    : /Android/.test(ua) ? 'android'
    : /CrOS/.test(ua) ? 'chromeos'
    : /Windows/.test(ua) ? 'windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'mac'
    : /Linux/.test(ua) ? 'linux' : 'other';
  const browser = /Edg(A|iOS)?\//.test(ua) ? 'edge'
    : /OPR\/|Opera/.test(ua) ? 'opera'
    : /Firefox|FxiOS/.test(ua) ? 'firefox'
    : (nav.brave || brands.includes('Brave')) ? 'brave'
    : /SamsungBrowser/.test(ua) ? 'samsung'
    : /Chrome|CriOS|Chromium/.test(ua) ? 'chrome'
    : /Safari/.test(ua) ? 'safari' : 'other';
  const hasBluetooth = !!nav.bluetooth;
  const secure = win.isSecureContext !== false;
  return { os, browser, hasBluetooth, secure, supported: hasBluetooth && secure, canRemember: !!nav.bluetooth?.getDevices };
}

export const OS_NAME = { mac: 'macOS', windows: 'Windows', android: 'Android', chromeos: 'ChromeOS', linux: 'Linux', ios: 'iOS / iPadOS', other: 'this system' };
export const BROWSER_NAME = { chrome: 'Chrome', edge: 'Edge', opera: 'Opera', brave: 'Brave', samsung: 'Samsung Internet', firefox: 'Firefox', safari: 'Safari', other: 'this browser' };

/** Why the app can't run here, with what to do instead. null when supported. */
export function blockReason(env) {
  if (env.supported) return null;
  if (!env.secure) {
    return {
      title: 'Open this page from a secure address',
      body: 'Browsers only allow Bluetooth on pages served over https:// or from http://localhost.',
      steps: ['If you are running it yourself, open http://localhost:8765 (run serve.sh).', 'If it is hosted, use the https:// address.'],
    };
  }
  if (env.os === 'ios') {
    return {
      title: 'iPhone and iPad browsers can’t use Bluetooth',
      body: 'Apple doesn’t let web pages talk to Bluetooth devices on iOS — this applies to Safari, Chrome and every other browser on iPhone/iPad.',
      steps: [
        'Use a Mac, Windows PC, Chromebook or Android phone/tablet with Chrome or Edge.',
        'Or try the third-party “Bluefy” browser from the App Store, which adds Web Bluetooth (not tested with this app).',
      ],
    };
  }
  if (env.browser === 'firefox' || env.browser === 'safari') {
    return {
      title: `${BROWSER_NAME[env.browser]} doesn’t support Bluetooth`,
      body: `This app controls the light over Web Bluetooth, which ${BROWSER_NAME[env.browser]} doesn’t provide.`,
      steps: ['Open this page in Google Chrome or Microsoft Edge.', 'Use “Copy link” below and paste it into Chrome or Edge.'],
    };
  }
  if (env.browser === 'brave') {
    return {
      title: 'Bluetooth is turned off in Brave',
      body: 'Brave disables Web Bluetooth by default.',
      steps: ['Use Google Chrome or Microsoft Edge (recommended).', 'Or, in Brave, open brave://flags, search “Web Bluetooth”, enable it and relaunch (if your version offers it).'],
    };
  }
  return {
    title: 'Bluetooth isn’t available in this browser',
    body: `${BROWSER_NAME[env.browser]} on ${OS_NAME[env.os]} isn’t exposing Web Bluetooth. It may be an older version, or it may be turned off by a setting or by your organization.`,
    steps: ['Update to the latest Google Chrome or Microsoft Edge and try again.', 'On a work-managed computer, Bluetooth for websites may be blocked by policy.'],
  };
}

/** OS-specific steps to get Bluetooth working for the browser. */
export function bluetoothSteps(env) {
  const b = BROWSER_NAME[env.browser] ?? 'your browser';
  switch (env.os) {
    case 'mac': return [
      'Turn Bluetooth on (Control Center → Bluetooth).',
      `Allow ${b} to use Bluetooth: System Settings → Privacy & Security → Bluetooth → turn on ${b}.`,
      `Quit ${b} completely (⌘Q) and reopen it after changing that setting.`,
    ];
    case 'windows': return [
      'Turn Bluetooth on: Settings → Bluetooth & devices → Bluetooth.',
      'You need Windows 10 or 11 and a Bluetooth 4.0 (LE) adapter.',
      'Don’t pair the light in Windows Settings — this app connects to it directly.',
    ];
    case 'android': return [
      'Turn Bluetooth on.',
      `Android 12 and newer: Settings → Apps → ${b} → Permissions → Nearby devices → Allow.`,
      `Android 11 and older: turn Location on and allow ${b} to use Location (Android requires it for Bluetooth scanning).`,
    ];
    case 'chromeos': return ['Turn Bluetooth on from the quick settings panel.'];
    case 'linux': return [
      'Turn Bluetooth on (BlueZ must be running).',
      'Linux support is untested. If Bluetooth still isn’t available, try enabling chrome://flags/#enable-experimental-web-platform-features.',
    ];
    default: return ['Turn Bluetooth on in your system settings.'];
  }
}

export const LIGHT_STEPS = [
  'Turn the light on.',
  'Set the light to App mode: press the small mode button on the light (it cycles through the modes) until the display shows APP. Switching to any other mode disconnects it.',
  'Close the GVM app on your phone (swipe it away) — the light accepts only one connection at a time. If it still won’t show up, turn the phone’s Bluetooth off.',
  'Keep the light within about 10 m / 30 ft of this device.',
  'In the device list, the light appears as “BT_LED”.',
];

/**
 * Turns a connection problem into {level, title, body, steps[]}.
 * level: 'info' | 'warn' | 'error'
 */
export function explainProblem(code, err, env) {
  const msg = `${err?.name ?? ''} ${err?.message ?? ''}`;
  switch (code) {
    case 'chooser': {
      if (/cancel/i.test(msg)) {
        return { level: 'info', title: 'No light selected', body: 'Didn’t see “BT_LED” in the list?', steps: LIGHT_STEPS.slice(0, 4) };
      }
      if (/globally disabled|disabled/i.test(msg)) return explainProblem('disabled', err, env);
      if (/adapter|not available|unavailable/i.test(msg)) return explainProblem('adapter', err, env);
      if (err?.name === 'SecurityError') return explainProblem('security', err, env);
      return { level: 'error', title: 'Couldn’t open the device list', body: err?.message ?? 'Unknown error.', steps: bluetoothSteps(env) };
    }
    case 'adapter':
      return { level: 'error', title: 'Bluetooth is off or blocked', body: `${BROWSER_NAME[env.browser] ?? 'The browser'} can’t reach a Bluetooth adapter.`, steps: bluetoothSteps(env) };
    case 'disabled':
      return { level: 'error', title: 'Web Bluetooth is turned off', body: 'Bluetooth for websites is disabled in this browser, possibly by a setting or your organization.', steps: ['Use the latest Google Chrome or Microsoft Edge.', 'Check chrome://flags and chrome://policy for Web Bluetooth settings.'] };
    case 'security':
      return { level: 'error', title: 'Bluetooth not allowed on this page', body: 'The page must be opened over https:// or http://localhost, and not inside another site’s frame.', steps: ['Open the app directly in its own tab or as the installed app.'] };
    case 'connect':
      return {
        level: 'error', title: 'Couldn’t connect to the light',
        body: 'The light was found but didn’t accept the connection.',
        steps: ['Make sure the GVM phone app is closed — if the phone is connected, the light refuses others.', 'Check the light is on, set to App mode, and nearby.', 'Press Connect to try again.'],
      };
    case 'not-light':
      return { level: 'error', title: 'That device isn’t a supported light', body: 'It doesn’t have the GVM control channel.', steps: ['Choose “BT_LED” from the list.', 'Settings → Forget this light, then pair again.'] };
    case 'forgotten':
      return {
        level: 'info', title: 'Pick the light again',
        body: 'The browser no longer remembers permission for your light, so it needs to be chosen once more.',
        steps: ['Press “Pair light” and choose BT_LED.'],
      };
    case 'lost':
      return { level: 'warn', title: 'Connection lost — reconnecting', body: 'The app keeps trying automatically.', steps: ['Check the light’s display still shows APP: switching it out of App mode with the mode button disconnects it. Press the mode button until APP shows again.', 'Check the light is still on and in range.', 'Make sure the phone app hasn’t taken over the light.'] };
    case 'retrying':
      return { level: 'error', title: 'Still can’t reach the light', body: 'Automatic reconnection is still running, but several attempts have failed.', steps: ['Does the light’s display show APP? Leaving App mode disconnects it; press the mode button until APP shows.', 'Is the light on and within range?', 'Close the GVM phone app or turn the phone’s Bluetooth off.', 'Power-cycle the light, then press Retry now.'] };
    default:
      return { level: 'error', title: 'Something went wrong', body: err?.message ?? String(code), steps: [] };
  }
}
