# Android packaging (PWABuilder / Trusted Web Activity)

The web app is PWA-complete: `manifest.json`, PNG + maskable icons and a service
worker are served from the site root. Packaging an Android APK/AAB is done
outside this repository with [PWABuilder](https://www.pwabuilder.com/) using the
deployed HTTPS URL.

## 1. Generate the package in PWABuilder

1. Open https://www.pwabuilder.com and enter the deployed URL (for example
   `https://ygqk69b2ys.dev.ap-jt.com`).
2. Confirm the report shows: manifest detected, `standalone` display, 192 and
   512 icons, maskable icon and a service worker.
3. Choose **Android** → **Generate package**. Set:
   - App name: `Hotel Sagarika BarFlow`
   - Short name: `BarFlow`
   - Package ID: `com.hotelsagarika.barflow`
   - Signing key: **Create new** (keep the generated `.keystore` and passwords
     safe — they are required for every future update).

PWABuilder produces `assetlinks.json` containing the SHA-256 fingerprint of the
key it generated, plus the `.aab`/`.apk`.

## 2. Publish Digital Asset Links

Digital Asset Links must be served from the **exact host** that the APK opens,
over HTTPS, at:

```
https://<host>/.well-known/assetlinks.json
```

`server/app.js` serves `dist/.well-known/assetlinks.json` explicitly (with
`Cache-Control: no-store`) because Express does not expose dot-directories from
static middleware by default.

Replace the placeholder values in `client/public/.well-known/assetlinks.json`:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.hotelsagarika.barflow",
      "sha256_cert_fingerprints": ["<SHA-256 FROM PWABUILDER / keytool>"]
    }
  }
]
```

Get the fingerprint for an existing key with:

```bash
keytool -list -v -keystore my-release-key.keystore -alias my-key-alias
# SHA256: AA:BB:...  -> paste the colon-separated value into the JSON
```

For Play App Signing, also add the **App signing key certificate** SHA-256 from
Play Console → Setup → App signing (Play re-signs the APK, so Google's key must
be listed too).

Deploy after editing. Verify with:

```bash
curl -s https://<host>/.well-known/assetlinks.json | jq .
```

and Google's validator:

```
https://developers.google.com/digital-asset-links/tools/generator
```

## 3. Requirements checklist

- [x] HTTPS on the deployed host (AppJet hosting terminates TLS).
- [x] `/.well-known/assetlinks.json` served as `application/json`.
- [x] `package_name` matches the APK application ID exactly.
- [x] At least one SHA-256 fingerprint of a key that signs the installed APK.
- [x] `start_url` and `scope` are `/`, so the TWA stays inside the app shell.
- [x] `display: standalone` and `orientation: portrait`.

## Notes

- Without a matching fingerprint the TWA still installs but shows the Chrome
  address bar; this is the standard "unverified" state, not a web bug.
- `navigator.serviceWorker` requires a secure context. On the deployed HTTPS URL
  it is active; on `http://localhost` it also works for local development.
- The service worker deliberately ignores `/api/*`, so billing, stock deduction,
  authentication and offline sync keep talking to the server directly.
