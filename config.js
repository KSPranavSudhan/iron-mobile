/* App configuration. Edit this file when you deploy. */
self.IRON_CONFIG = {
  // Bump when the app CODE changes in a way that bundles may depend on (bundle.min_app_version is checked against it).
  APP_VERSION: 1,

  // Where the app looks for model updates. Relative = same host as the app; or an absolute URL
  // (GitHub Pages / raw.githubusercontent.com / your own server -- must allow CORS and be HTTPS).
  UPDATE_MANIFEST_URL: 'model/latest.json',

  // ECDSA P-256 public key (JWK) that signs model updates. Generate with:
  //   python tools/model_tool.py keygen --out-private iron_signing_key.pem --out-public-jwk public_key.jwk.json
  // While null, updates are accepted on SHA-256 integrity alone (fine for local testing, NOT for release).
  UPDATE_PUBLIC_KEY: null,
  REQUIRE_SIGNATURE: false,   // set true once UPDATE_PUBLIC_KEY is set: refuses unsigned updates

  AUTO_CHECK_UPDATES: true,   // quietly check on launch (at most once every 6 h) and show a banner if a model update exists
  AUTO_CHECK_INTERVAL_MS: 6 * 3600 * 1000,
};
